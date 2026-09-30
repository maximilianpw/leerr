import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "../../passwords.ts";
import { roles } from "../../store.ts";
import { validateEndpoint } from "../../upstream/index.ts";
import { lidarrAccess, password, revokeUser, username, type AppContext } from "../context.ts";
import { APIError, notFound } from "../errors.ts";

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

  app.patch("/api/v1/admin/users/:id", async (request) => {
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
    store.transaction(() => {
      const removesAdmin =
        target.role === "admin" && !target.disabled && (body.disabled === true || body.role === "member");
      if (removesAdmin && store.activeAdminCount() <= 1)
        throw new APIError(409, "last_admin", "Keep at least one active administrator.");
      store.updateUser(id, { passwordHash: hashed, disabled: body.disabled, role: body.role });
      if (hashed || body.disabled) revokeUser(context, id);
    });
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
      rootFolderPath: settings.rootFolderPath || null,
      qualityProfileID: settings.qualityProfileID || null,
      metadataProfileID: settings.metadataProfileID || null,
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
        rootFolderPath: z.string().max(1000).default(""),
        qualityProfileID: z.number().int().nonnegative().default(0),
        metadataProfileID: z.number().int().nonnegative().default(0),
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
    if (moved && store.pendingMutationCount() > 0)
      throw new APIError(
        409,
        "lidarr_busy",
        "Some requests have unconfirmed changes in the current Lidarr. Resolve or remove them under Requests before switching.",
      );
    if (url) await context.upstream.lidarrOptions({ endpoint: url, key });
    auth.require(request, true);
    const current = store.settings();
    if (JSON.stringify(current) !== JSON.stringify(previous))
      throw new APIError(409, "settings_changed", "Settings changed meanwhile. Reload and try again.");
    store.transaction(() => {
      store.saveSettings({
        ...current,
        lidarrURL: url,
        lidarrKey: url ? key : "",
        rootFolderPath: url ? body.rootFolderPath : "",
        qualityProfileID: url ? body.qualityProfileID : 0,
        metadataProfileID: url ? body.metadataProfileID : 0,
      });
      if (moved) store.restartAcquisitions(context.now());
    });
    log("settings_lidarr", { actor: actor.user.id, configured: !!url, moved });
    void context.reconciler.run();
    return {};
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
        retryable: row.status === "failed" || row.status === "attention",
        updatedAt: new Date(row.updatedAt).toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/acquisitions/:id/retry", async (request) => {
    const actor = auth.require(request, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!store.acquisition(id)) throw notFound("Request");
    if (!context.reconciler.retry(id))
      throw new APIError(409, "not_retryable", "Only failed requests or requests needing attention can be retried.");
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
