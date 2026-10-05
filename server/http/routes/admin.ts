import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "../../passwords.ts";
import { lidarrReady, notifyFormats, roles } from "../../store.ts";
import { UpstreamError, validateEndpoint } from "../../upstream/index.ts";
import { lidarrAccess, password, revokeUser, username, type AppContext } from "../context.ts";
import { APIError, notFound } from "../errors.ts";

/** Upstream probes are cached briefly so the status page cannot hammer Jellyfin or Lidarr. */
const PROBE_TTL = 10_000;
type Probe = { state: "ok" | "error" | "unconfigured"; message: string; version: string | null; latencyMs: number | null };

const fixtureRefusal = () =>
  new APIError(403, "fixture_preview", "This demo cannot save service settings. Use a real Leerr deployment.");

export function adminRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, log } = context;

  app.get("/api/v1/admin/users", async (request) => {
    auth.require(request, true);
    return {
      items: store.users().map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        disabled: user.disabled,
        createdAt: new Date(user.createdAt).toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/users", async (request) => {
    const actor = auth.require(request, true);
    const body = z.object({ username, password, role: z.enum(roles) }).parse(request.body);
    if (store.userByName(body.username)) throw new APIError(409, "duplicate_user", "That username is already taken.");
    const hashed = await hashPassword(body.password);
    auth.require(request, true);
    if (store.userByName(body.username)) throw new APIError(409, "duplicate_user", "That username is already taken.");
    const user = store.createUser(body.username, hashed, body.role, context.now());
    log("user_created", { actor: actor.user.id, user: user.id, role: user.role });
    return { id: user.id };
  });

  app.patch("/api/v1/admin/users/:id", async (request, reply) => {
    const actor = auth.require(request, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ disabled: z.boolean().optional(), password: password.optional(), role: z.enum(roles).optional() })
      .refine((value) => value.disabled !== undefined || value.password !== undefined || value.role !== undefined)
      .parse(request.body);
    const target = store.user(id);
    if (!target) throw notFound("User");
    const hashed = body.password ? await hashPassword(body.password) : undefined;
    auth.require(request, true);
    const self = id === actor.user.id;
    store.transaction(() => {
      const removesAdmin =
        target.role === "admin" && !target.disabled && (body.disabled === true || body.role === "member");
      if (removesAdmin && store.activeAdminCount() <= 1)
        throw new APIError(409, "last_admin", "Keep at least one active administrator.");
      store.updateUser(id, { passwordHash: hashed, disabled: body.disabled, role: body.role });
      // An administrator setting their own password stays signed in here, as with /me/password.
      if (hashed || body.disabled) revokeUser(context, id, self ? actor.session.id : null);
    });
    if (hashed && self && actor.session.device === "web")
      auth.setDeviceCookie(reply, id, store.createDevice(id, context.now()));
    // A reset or re-enable is how people recover from a lockout; the old lock must not outlive it.
    if (hashed || body.disabled === false) context.logins.clear(`account:${target.username}`);
    log("user_updated", {
      actor: actor.user.id,
      user: id,
      password: !!hashed,
      disabled: body.disabled ?? null,
      role: body.role ?? null,
    });
    return {};
  });

  app.get("/api/v1/admin/settings", async (request) => {
    auth.require(request, true);
    const settings = store.settings();
    return {
      jellyfinURL: settings.jellyfinURL,
      lidarrURL: settings.lidarrURL,
      lidarrConfigured: !!settings.lidarrURL && !!settings.lidarrKey,
      lidarrReady: lidarrReady(settings),
      rootFolderPath: settings.rootFolderPath || null,
      qualityProfileID: settings.qualityProfileID || null,
      metadataProfileID: settings.metadataProfileID || null,
      lastfmConfigured: !!settings.lastfmKey,
      // For Discord and ntfy the address itself is the credential: only its host is shown.
      notifyTarget: settings.notifyURL ? `${new URL(settings.notifyURL).host}/…` : null,
      notifyFormat: settings.notifyFormat,
      notifyTokenSet: !!settings.notifyToken,
    };
  });

  app.put("/api/v1/admin/settings/jellyfin", async (request) => {
    const actor = auth.require(request, true);
    if (context.fixturePreview) throw fixtureRefusal();
    const body = z.object({ url: z.string().max(2000) }).parse(request.body);
    const url = body.url.trim() ? validateEndpoint(body.url) : null;
    const previous = store.settings();
    if (url === previous.jellyfinURL) return {};
    store.transaction(() => {
      // Tokens belong to the old installation and must never be sent to a new host.
      store.deleteServiceSecrets("jellyfin");
      store.deleteAllTickets();
      store.saveSettings({ ...previous, jellyfinURL: url });
    });
    context.streams.abortAll();
    context.library.invalidate();
    log("settings_jellyfin", { actor: actor.user.id, configured: !!url });
    return {};
  });

  app.put("/api/v1/admin/settings/lidarr", async (request) => {
    const actor = auth.require(request, true);
    if (context.fixturePreview) throw fixtureRefusal();
    const body = z
      .object({
        url: z.string().max(2000),
        apiKey: z.string().max(512).default(""),
        // Omitted profile fields keep their saved values on the same host.
        rootFolderPath: z.string().max(1000).optional(),
        qualityProfileID: z.number().int().nonnegative().optional(),
        metadataProfileID: z.number().int().nonnegative().optional(),
      })
      .parse(request.body);
    const previous = store.settings();
    const url = body.url.trim() ? validateEndpoint(body.url) : null;
    const moved = url !== previous.lidarrURL;
    // A key is never carried over to a different host.
    const key = body.apiKey.trim() || (moved ? "" : previous.lidarrKey);
    if (url && !key)
      throw new APIError(
        400,
        "lidarr_key_required",
        "Enter the API key from Lidarr Settings → General → Security.",
      );
    const busy = () =>
      new APIError(
        409,
        "lidarr_busy",
        "Some requests have unconfirmed changes in the current Lidarr. Retry or remove them under Settings → All requests before switching.",
      );
    if (moved && store.pendingMutationCount() > 0) throw busy();
    const options = url ? await context.upstream.lidarrOptions({ endpoint: url, key }) : null;
    // Choices must come from this Lidarr: a page still showing another host's lists cannot save them.
    if (
      options &&
      ((body.rootFolderPath && !options.roots.some((root) => root.path === body.rootFolderPath)) ||
        (body.qualityProfileID && !options.qualities.some((profile) => profile.id === body.qualityProfileID)) ||
        (body.metadataProfileID && !options.metadata.some((profile) => profile.id === body.metadataProfileID)))
    )
      throw new APIError(
        400,
        "lidarr_option_unknown",
        "This Lidarr has no such root folder or profile. Reload the page and choose again.",
      );
    auth.require(request, true);
    const current = store.settings();
    if (JSON.stringify(current) !== JSON.stringify(previous))
      throw new APIError(409, "settings_changed", "Settings changed meanwhile. Reload and try again.");
    const keep = <T>(value: T | undefined, saved: T, empty: T) => (!url ? empty : value ?? (moved ? empty : saved));
    const next = {
      ...current,
      lidarrURL: url,
      lidarrKey: url ? key : "",
      rootFolderPath: keep(body.rootFolderPath, current.rootFolderPath, ""),
      qualityProfileID: keep(body.qualityProfileID, current.qualityProfileID, 0),
      metadataProfileID: keep(body.metadataProfileID, current.metadataProfileID, 0),
    };
    store.transaction(() => {
      // Checked again here: a mutation may have been journalled while Lidarr was being verified.
      if (moved && store.pendingMutationCount() > 0) throw busy();
      store.saveSettings(next);
      if (moved) store.restartAcquisitions(context.now());
      // Requests that waited for profiles (or backed off without them) start now.
      else if (lidarrReady(next)) store.wakeWaitingAcquisitions(context.now());
    });
    log("settings_lidarr", { actor: actor.user.id, configured: !!url, moved, ready: lidarrReady(next) });
    void context.reconciler.run();
    return {};
  });

  app.put("/api/v1/admin/settings/lastfm", async (request) => {
    const actor = auth.require(request, true);
    if (context.fixturePreview) throw fixtureRefusal();
    const body = z.object({ apiKey: z.string().trim().max(200) }).parse(request.body);
    if (body.apiKey) await context.upstream.lastfmCheckKey(body.apiKey);
    auth.require(request, true);
    store.saveSettings({ ...store.settings(), lastfmKey: body.apiKey });
    log("settings_lastfm", { actor: actor.user.id, configured: !!body.apiKey });
    return {};
  });

  app.put("/api/v1/admin/settings/notifications", async (request) => {
    const actor = auth.require(request, true);
    if (context.fixturePreview) throw fixtureRefusal();
    const body = z
      .object({
        // Blank keeps the saved address, null turns notifications off.
        url: z.string().max(2000).nullable().default(""),
        format: z.enum(notifyFormats),
        // Blank keeps the saved token for a kept address; a new address never inherits it.
        token: z.string().trim().max(500).default(""),
      })
      .parse(request.body);
    const previous = store.settings();
    const kept = body.url !== null && !body.url.trim();
    if (kept && !previous.notifyURL) throw new APIError(400, "invalid_endpoint", "Enter the address notifications go to.");
    const url = body.url === null ? null : kept ? previous.notifyURL : validateEndpoint(body.url);
    const token = url ? body.token || (kept ? previous.notifyToken : "") : "";
    store.saveSettings({ ...previous, notifyURL: url, notifyFormat: body.format, notifyToken: token });
    log("settings_notifications", { actor: actor.user.id, configured: !!url, format: body.format });
    return {};
  });

  app.post("/api/v1/admin/notifications/test", async (request) => {
    auth.require(request, true);
    if (context.fixturePreview) throw fixtureRefusal();
    const settings = store.settings();
    if (!settings.notifyURL)
      throw new APIError(409, "notifications_not_configured", "Save a notification address first.");
    await context.upstream.notify(
      { url: settings.notifyURL, format: settings.notifyFormat, token: settings.notifyToken },
      {
        event: "test",
        title: "Leerr notifications work",
        message: "This is a test from Leerr. Requests will be announced here when they arrive or need attention.",
        album: null,
        requesters: [],
      },
    );
    return {};
  });

  const probes = new Map<string, { probe: Promise<Probe>; expiresAt: number }>();
  const probe = (name: string, configured: boolean, check: () => Promise<string>): Promise<Probe> => {
    if (!configured) return Promise.resolve({ state: "unconfigured", message: "Not set up.", version: null, latencyMs: null });
    const cached = probes.get(name);
    if (cached && cached.expiresAt > context.now()) return cached.probe;
    const started = performance.now();
    const result = check().then(
      (version): Probe => ({ state: "ok", message: "Connected.", version, latencyMs: Math.round(performance.now() - started) }),
      (cause: Error): Probe => {
        if (!(cause instanceof UpstreamError)) throw cause;
        return { state: "error", message: cause.message, version: null, latencyMs: null };
      },
    );
    probes.set(name, { probe: result, expiresAt: context.now() + PROBE_TTL });
    return result;
  };

  app.get("/api/v1/admin/status", async (request) => {
    auth.require(request, true);
    const settings = store.settings();
    const [jellyfin, lidarr] = await Promise.all([
      probe(`jellyfin:${settings.jellyfinURL}`, !!settings.jellyfinURL, () =>
        context.upstream.jellyfinVersion(settings.jellyfinURL ?? ""),
      ),
      probe(`lidarr:${settings.lidarrURL}`, !!settings.lidarrURL && !!settings.lidarrKey, () =>
        context.upstream.lidarrVersion({ endpoint: settings.lidarrURL ?? "", key: settings.lidarrKey }),
      ),
    ]);
    const worker = context.reconciler.status();
    const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
    return {
      jellyfin,
      lidarr,
      lidarrReady: lidarrReady(settings),
      worker: {
        lastPassAt: iso(worker.lastPassAt),
        lastError: worker.lastError?.message ?? null,
        lastErrorAt: iso(worker.lastError?.at ?? null),
        pendingChanges: store.pendingMutationCount(),
      },
      acquisitions: store.acquisitionCounts(),
      streams: context.streams.size,
      startedAt: new Date(context.runtime.startedAt).toISOString(),
      lastBackup: context.runtime.lastBackup
        ? { at: new Date(context.runtime.lastBackup.at).toISOString(), ok: context.runtime.lastBackup.ok }
        : null,
    };
  });

  app.get("/api/v1/admin/lidarr/options", async (request) => {
    auth.require(request, true);
    return context.upstream.lidarrOptions(lidarrAccess(context));
  });

  app.get("/api/v1/admin/acquisitions", async (request) => {
    auth.require(request, true);
    return {
      items: store.acquisitions().map((row) => ({
        id: row.id,
        releaseGroupMBID: row.releaseGroupMBID,
        releaseMBID: row.releaseMBID,
        title: row.title,
        artist: row.artist,
        status: row.status,
        reason: row.reason,
        phase: row.phase,
        requesters: row.requesters,
        // An imported album can be re-checked, e.g. after it was removed from Lidarr.
        retryable: row.status === "failed" || row.status === "attention" || row.status === "imported",
        updatedAt: new Date(row.updatedAt).toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/acquisitions/:id/retry", async (request) => {
    const actor = auth.require(request, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!store.acquisition(id)) throw notFound("Request");
    if (!context.reconciler.retry(id, true))
      throw new APIError(409, "not_retryable", "This request is still in progress. Wait until it finishes, fails or needs attention.");
    log("acquisition_retry", { actor: actor.user.id, acquisition: id });
    void context.reconciler.run();
    return {};
  });

  app.delete("/api/v1/admin/acquisitions/:id", async (request) => {
    const actor = auth.require(request, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!store.deleteAcquisition(id)) throw notFound("Request");
    log("acquisition_deleted", { actor: actor.user.id, acquisition: id });
    return {};
  });
}
