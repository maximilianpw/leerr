import { ChevronRight, LoaderCircle } from "lucide-react";
import type { FormEvent } from "react";
import { meSchema, request, send, type User } from "../api.ts";
import { useAction } from "../hooks.ts";
import { Brand, ErrorBox, Field, Notice } from "../ui.tsx";

export function AuthPage({
  mode,
  notice,
  onSetup,
  onLogin,
}: {
  mode: "setup" | "login";
  notice: string;
  onSetup: () => void;
  onLogin: (user: User, csrf: string | null) => void;
}) {
  const action = useAction();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? "");
    void action.run(async () => {
      if (mode === "setup") {
        await send("/setup", "POST", { token: field("token").trim(), username: field("username"), password: field("password") });
        onSetup();
        return;
      }
      const session = await request("/sessions", meSchema, {
        method: "POST",
        body: JSON.stringify({ username: field("username"), password: field("password"), device: "web", name: browserName() }),
      });
      onLogin(session.user, session.csrf);
    });
  }

  return (
    <div className="auth">
      <section className="authIntro" aria-hidden="true">
        <Brand />
        <h2>
          Find albums.
          <br />
          Request them.
          <br />
          Play them.
        </h2>
        <p>Discover music, request it for your Jellyfin library, and listen anywhere.</p>
      </section>
      <main className="authCard">
        <Brand />
        <h1>{mode === "setup" ? "Set up Leerr" : "Sign in"}</h1>
        <p className="muted">
          {mode === "setup"
            ? "Create the first administrator. The setup token is in the setup-token file in Leerr's data directory."
            : "Welcome back."}
        </p>
        {notice && <Notice>{notice}</Notice>}
        <form onSubmit={submit}>
          {mode === "setup" && <Field label="Setup token" name="token" autoComplete="off" spellCheck={false} />}
          <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            minLength={mode === "setup" ? 10 : undefined}
            hint={mode === "setup" ? "At least 10 characters." : undefined}
          />
          {action.error && <ErrorBox message={action.error} />}
          <button className="primary wide" disabled={action.pending}>
            {action.pending ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            {mode === "setup" ? "Create administrator" : "Sign in"}
            {!action.pending && <ChevronRight aria-hidden="true" />}
          </button>
        </form>
      </main>
    </div>
  );
}

function browserName(): string {
  const agent = navigator.userAgent;
  const browser = /Firefox\//.test(agent)
    ? "Firefox"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const platform = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return platform ? `${browser} on ${platform}` : browser;
}
