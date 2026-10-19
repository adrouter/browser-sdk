# AdRouter browser SDK 0.1.1

Route your text chatbot through AdRouter and show a sponsored card beside an unchanged answer.
The browser client, optional React components and Web API server proxy are separate exports.
Pilot 1 supports publisher-paid DeepSeek inference and fictional demo campaigns. Measurements
are test views, never advertiser revenue or publisher earnings.

## 1. Requirements and installation

You need an HTTPS publisher on Cloudflare Pages Functions, a real hostname-specific Turnstile
widget, and an operator-approved app, provider connection and placement. The server must receive
Cloudflare's trusted `CF-Connecting-IP` header. The operator completes setup in
[Developers](https://app-staging.adrouter.co/developers), using Google sign-in in native Safari:

1. Create a paused app for your exact HTTPS origin, without a trailing slash or path.
2. Enter the publisher's DeepSeek key as a provider connection, then pass the original,
   multi-turn and Unicode qualification fixtures. All three must show qualified.
3. Load the fictional demo inventory and prepare it once. Preparation failure requires a new
   inventory version; uncertain provider outcomes must be investigated before another attempt.
4. Register a placement for the app's origin, review it and issue a publisher key.
5. Keep the app and publisher paused until readiness has no blockers and activation is agreed.

Install the release tarball; npm publication is disabled:

```sh
npm install https://github.com/adrouter/browser-sdk/releases/download/v0.1.1/adrouter-browser-sdk-0.1.1.tgz
```

The release also contains `adrouter-browser-sdk-0.1.1.tgz.json`, with SHA-256, package integrity
and source identity. Verify downloaded tarballs against it before installation. Package bytes
are immutable; fixes use a new version. React 19 is an optional peer dependency. The package
is MIT-licensed and its source is available in this repository.

0.1.1 fixes the server proxy on Cloudflare Workers. In 0.1.0 every gateway relay asked `fetch` for
`redirect: 'error'`, which the Workers runtime rejects, so chat and the other relayed routes returned
`service_unavailable` before reaching the gateway. 0.1.1 uses `redirect: 'manual'` and refuses any
gateway redirect. Replace 0.1.0 with 0.1.1; nothing else changes.

## 2. Server proxy

Keep every credential in server bindings. Do not put provider or publisher keys in Vite
variables, browser code, local storage, logs or screenshots. The publisher's server owns the
model, provider connection, placement and persona prompt. Browser requests cannot supply them.

Create `server/adrouter.ts` outside the `functions` routing directory:

```ts
import { createPublisherProxy } from '@adrouter/browser-sdk/server';

export interface Env {
  ADROUTER_APP_CREDENTIAL: string;
  ADROUTER_PROVIDER_CONNECTION_ID: string;
  ADROUTER_PLACEMENT_ID: string;
  ADROUTER_MODEL: string;
  ADROUTER_GATEWAY_ORIGIN: string;
  PUBLISHER_ORIGIN: string;
  SESSION_SIGNING_SECRET: string;
  REFERENCE_HMAC_SECRET: string;
  TURNSTILE_SECRET: string;
  RUN_UNTIL?: string;
}
const personas: Record<string, string> = {
  rowan: 'You are Rowan, the fictional keeper of a quiet forest inn. Respond warmly and concisely.',
};
export function publisher(env: Env) {
  return createPublisherProxy({
    gatewayOrigin: env.ADROUTER_GATEWAY_ORIGIN,
    allowedOrigin: env.PUBLISHER_ORIGIN,
    appCredential: env.ADROUTER_APP_CREDENTIAL,
    providerConnectionId: env.ADROUTER_PROVIDER_CONNECTION_ID,
    placementId: env.ADROUTER_PLACEMENT_ID,
    model: env.ADROUTER_MODEL,
    systemInstruction: ({ persona }) => personas[persona ?? 'rowan'],
    sessionSigningSecret: env.SESSION_SIGNING_SECRET,
    referenceHmacSecret: env.REFERENCE_HMAC_SECRET,
    turnstileSecret: env.TURNSTILE_SECRET,
    runUntil: env.RUN_UNTIL || undefined,
  });
}
```

The model ID comes from the qualified connection and gateway catalog. Pilot 1's source resolves
`deepseek-v4-flash`. Use the exact IDs shown by the console. Each signing/HMAC secret needs at
least 32 random bytes from a password manager. Use different values for the two purposes.

Wire these Pages Function handlers to the proxy. The examples use small local structural types;
you may use Cloudflare's generated `PagesFunction<Env>` types instead.

```ts
// functions/api/session.ts
import { publisher, type Env } from '../../server/adrouter';
export const onRequestPost = ({ request, env }: { request: Request; env: Env }) =>
  publisher(env).session(request);

// functions/api/chat.ts
import { publisher, type Env } from '../../server/adrouter';
export const onRequestPost = ({ request, env }: { request: Request; env: Env }) =>
  publisher(env).chat(request);

// functions/api/turns/[id]/index.ts
import { publisher, type Env } from '../../../../server/adrouter';
export const onRequestGet = ({ request, env, params }: {
  request: Request; env: Env; params: { id: string };
}) => publisher(env).status(request, params.id);

// functions/api/turns/[id]/cancel.ts
import { publisher, type Env } from '../../../../server/adrouter';
export const onRequestPost = ({ request, env, params }: {
  request: Request; env: Env; params: { id: string };
}) => publisher(env).cancel(request, params.id);

// functions/api/feedback.ts
import { publisher, type Env } from '../../server/adrouter';
export const onRequestPost = ({ request, env }: { request: Request; env: Env }) =>
  publisher(env).feedback(request);

// functions/api/client-events.ts
import { publisher, type Env } from '../../server/adrouter';
export const onRequestPost = ({ request, env }: { request: Request; env: Env }) =>
  publisher(env).clientEvents(request);
```

Preserve the publisher's explicit paused state before invoking `chat`. Do not keep a direct
provider fallback after cutover. Forward streaming responses without reading or buffering their
bodies. Apply your security headers to static files and Function responses, including errors.
Your CSP must allow the real Turnstile script/frame and the gateway measurement origin in
`connect-src`. Never enable broad CORS on these publisher mutation routes.

## 3. Browser core

Issue the signed `__Host-adr_session` cookie before the first turn:

```ts
const session = await fetch('/api/session', { method: 'POST' });
if (!session.ok) throw new Error('Publisher session could not be created.');
```

The real Turnstile widget must use action `chat`. Keep its token in memory, consume it once,
and reset the widget after the attempted POST. Never use test keys on a hosted publisher. The
server validates success, hostname and action before gateway creation.

```ts
import { createAdRouterClient, renderSponsorCard } from '@adrouter/browser-sdk';

const client = createAdRouterClient({
  endpoints: {
    chat: '/api/chat',
    status: id => `/api/turns/${encodeURIComponent(id)}`,
    cancel: id => `/api/turns/${encodeURIComponent(id)}/cancel`,
    feedback: '/api/feedback',
    clientEvents: '/api/client-events',
    measurement: 'https://adrouter-v3.fly.dev/v3/sponsor/events',
  },
  persona: 'rowan',
  getTurnstileToken: takeFreshTokenFromYourWidget,
  history: { maxMessages: 14, maxBytes: 12_000 },
  onHistoryTrimmed: () => {
    historyNotice.textContent = 'Earlier messages are no longer sent to the model.';
  },
  onModelDelta: text => { answerElement.textContent += text; },
  onSponsorOffer: offer => {
    sponsorContainer.replaceChildren();
    renderSponsorCard({ client, offer, container: sponsorContainer });
  },
  onSponsorNone: () => { sponsorContainer.replaceChildren(); },
  onError: error => { errorNotice.textContent = error.message; },
});
const turn = client.sendTurn({ messages: [{ role: 'user', content: 'Hello, Rowan.' }] });
const result = await turn.done;
// Only a complete successful model response should extend model history.
if (result.delivery !== 'complete') showInterruptedNotice();
// Stop the active request with await turn.cancel(). Dispose client on real unmount.
```

`takeFreshTokenFromYourWidget`, display elements and interruption handling belong to your
publisher. They are not SDK globals. Sponsor copy belongs only in its reserved placement. Copy
answers from your model-text state, never from a container holding sponsored content.

## 4. React

Use the same endpoint and Turnstile options with the optional React export:

```tsx
import { useAdRouterChat, SponsoredCard } from '@adrouter/browser-sdk/react';

function Chat() {
  const chat = useAdRouterChat(options);
  return <>
    {chat.state.messages.map((message, i) => <p key={i}>{message.content}</p>)}
    {(chat.state.busy || chat.state.error) && <p>{chat.state.answer}</p>}
    {chat.state.historyTrimmed && <p role="status">
      Earlier messages are no longer sent to the model. Your latest message is kept.
    </p>}
    <div className="reserved-sponsor-slot">
      {chat.state.offer && <SponsoredCard client={chat.client} offer={chat.state.offer} />}
    </div>
    {chat.state.error && <p role="alert">{chat.state.error.message}</p>}
    <button disabled={chat.state.busy} onClick={() => void chat.send(draft)}>Send</button>
    <button disabled={!chat.state.busy} onClick={() => void chat.cancel()}>Stop</button>
  </>;
}
```

Use completed history and the in-progress answer as separate views, so a completed assistant
message is not rendered twice. Keep history storage in your browser if desired. Never persist
sponsor offers, receipts, keys or partial answers as model conversation history.

## 5. Disclosure and measurement

Every card must visibly display `Sponsored`, the advertiser name, title/body and destination.
Synthetic cards additionally display exactly:

> Demo campaign · fictional brand · not a paid placement

The built-in renderer includes these elements and the accessible label
`Sponsored placement · demo campaign`. Give the card an opaque background, sufficient space,
at least 12px readable text and 4.5:1 contrast. Keep it in the document flow and unobstructed.
The SDK does not infer successful rendering merely because an offer exists.

Custom renderers use `client.registerPlacement` with element bindings
`{ root, disclosure, advertiser, content, destination, demoDisclosure }`. Omission or hiding of
the synthetic demo disclosure produces `missing_disclosure`. Never replace it with an aria-only
label. Measurement needs at least 50% visibility continuously for one second, a visible/focused
document, complete disclosures and readable, uncovered content. Hidden, clipped, covered or
scrolled-away cards do not qualify. The result is a `qualified_test_view`, not revenue.

Measurement retries reuse stable event IDs and are bounded. Generation is never retried
automatically. Re-rendering the same offer cannot create an extra qualified test view.

## 6. Limits, personas and recovery

The default history trim retains at most 14 messages and 12,000 UTF-8 bytes, dropping oldest
messages first. The newest user message remains intact. An oversized newest message fails
before Turnstile or generation. Core clients must supply `onHistoryTrimmed` before trimming can
proceed. Render the trimming notice visibly. The gateway still enforces
4,096 full input tokens, 1,024 latest-user tokens, 512 output tokens, 16 messages including the
server prompt, and 64 KiB bodies. Byte trimming cannot guarantee exact tokenizer fit; shorten
input after `input_limit` rather than automatically retrying a paid request.

`persona` sends only a slug in `X-AdRouter-Persona`. Resolve it from a server-owned allowlist
before Turnstile verification. Unknown slugs fail with `unknown_persona`. A static
`systemInstruction` needs no persona header; several personas can share one app, connection,
placement and endpoint. Never accept a system prompt from browser input.

`runUntil` is optional. If supplied, use a valid future UTC timestamp; new creation stops at
that deadline. Daily caps and matching deadlines come from gateway readiness, not SDK constants.
The pilot defaults to 50 session, 100 IP, 1,000 app and 2,000 global turns per Singapore day,
with one active inference slot. An optional distant deadline does not use a long Node timer.

No-fill, opt-out, sensitive-topic suppression, matching failures and exhausted embedding budget
must still allow the model answer. Budget exhaustion uses keyword-only matching. These outcomes
do not permit another paid chat POST. After a stream interruption, retain local partial display
separately and recover only metadata with `getTurnStatus`. A duplicate operation returns
metadata and never replays provider inference.

## 7. Troubleshooting and cutover

| Outcome | Check / action |
| --- | --- |
| `session_invalid` | HTTPS origin, signed cookie, cookie name/attributes, signing-secret stability |
| `forbidden` | Exact publisher origin, trusted Cloudflare IP header and reviewed placement origin |
| `unknown_persona` | Browser slug matches the server-owned persona map |
| `turnstile_failed` | Real widget, exact hostname, `chat` action, fresh token; reset after an attempted POST |
| `service_unavailable` from `/api/chat` while `/api/session` succeeds | SDK 0.1.0 on Cloudflare Workers; upgrade to 0.1.1 |
| `connection_unavailable` | Paused app qualification, all three fixtures, current credential/tokenizer revision |
| Daily limit / `global_busy` | Read the configured cap or wait for the current turn; do not retry uncertain inference |
| `input_limit` | Shorten the newest message or history; output remains capped at 512 |
| `missing_disclosure` / unqualified view | Visible Sponsored and demo labels, readable card, no clipping/overlays |
| Interrupted delivery | No paid retry; inspect metadata and preserve uncertainty |

Deploy publisher Functions through Wrangler from a clean reviewed commit. Enable in this order:
gateway admission, readiness without blockers, app, publisher. After a successful gateway turn,
delete the publisher's direct DeepSeek secret and remove all direct-provider code. Keep the
standalone proof and source tag as historical evidence. Pause the app after the pilot session.
Record artifact IDs and outcome counts only, without transcripts, creatives or credentials.

## Reproduce the package from source

The release compression toolchain is Node 22.19.0 and npm 10.9.3. Select `.nvmrc`, then run
`npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:package` from a clean
checkout. The packaging check rejects a different toolchain or changed existing tarball bytes.
This pins package reproduction; publishers may keep their own supported application toolchain.
