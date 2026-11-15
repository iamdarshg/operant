# Discord API facts for a DSH-driven bot (Node 24)

Provenance: read 2026-11-15 from the **current** official docs (Discord moved
them to `docs.discord.com`; the old `discord.com/developers/docs/...` URLs
301 to the same pages), the npm registry, and the published typings of the
library in question. Nothing here is from memory or from secondhand blog posts;
each claim carries the page it came from.

Sources:

| Claim area | URL |
|---|---|
| Intents, bit values, privileged set | https://docs.discord.com/developers/events/gateway |
| `MESSAGE_CONTENT` rules, empty-field behaviour | same page, "Message Content Intent" |
| Message object / create-message limits | https://docs.discord.com/developers/resources/message |
| Uploading files, per-file size, file groups | https://docs.discord.com/developers/reference |
| discord.js current version | https://registry.npmjs.org/discord.js/latest |
| `@discordjs/voice` current version + deps | https://registry.npmjs.org/%40discordjs%2Fvoice/latest |
| Voice receive API surface | `@discordjs/voice@0.19.2` published typings (`unpkg.com/@discordjs/voice@0.19.2/dist/index.d.ts`) |
| Voice receive status wording | `raw.githubusercontent.com/discordjs/discord.js/main/packages/voice/README.md` |

---

## 1. Gateway intents

### 1.1 What each job needs

| Job | Intent(s) | Bit | Privileged? |
|---|---|---|---|
| Read messages in authorized channels | `GUILD_MESSAGES` (+ `GUILDS` for guild/channel state) | `1 << 9` | no |
| Actually see what those messages say | `MESSAGE_CONTENT` | `1 << 15` | **yes** |
| Receive voice-channel state (`VOICE_STATE_UPDATE`) | `GUILD_VOICE_STATES` | `1 << 7` | no |
| DMs with the bot | `DIRECT_MESSAGES` | `1 << 12` | no |
| Member objects / member events | `GUILD_MEMBERS` | `1 << 1` | **yes** |
| Presence | `GUILD_PRESENCES` | `1 << 8` | **yes** |
| Slash commands, buttons, modals | **none** | — | — |

`INTERACTION_CREATE` appears nowhere in the intents table, i.e. application
commands and components are delivered without any intent. You still need the
application command registered and the app installed with the right scopes; and
you must answer within the interaction window (3 s) or accept the deferred
acknowledgement path.

Privileged intents are exactly three — `GUILD_PRESENCES`, `GUILD_MEMBERS`,
`MESSAGE_CONTENT`. They must be toggled on the app's **Bot** page in the
Developer Portal before you may name them in `IDENTIFY`; naming an unconfigured
privileged intent closes the connection with code **4014**. Under 10,000 unique
users you self-enable in the portal; above that you go through privileged-intent
review.

A minimal, honest intent set for "read text + follow voice state + answer slash
commands" is `GUILDS | GUILD_MESSAGES | GUILD_VOICE_STATES | MESSAGE_CONTENT`
(`1 | 512 | 128 | 32768` = `33409`). Drop `MESSAGE_CONTENT` if you can live with
prefix-free slash commands only — see §3.

`GUILD_VOICE_STATES` is what `@discordjs/voice`'s gateway adapter needs in order
to see `VOICE_STATE_UPDATE` for its own connection; without it
`joinVoiceChannel` never reaches `Ready`.

---

## 2. Library choice for Node 24

- **discord.js `14.28.1`** is the current published version
  (`engines.node >= 18`). Major version is still **14**.
- Voice lives in the sibling package **`@discordjs/voice` `0.19.2`**
  (`engines.node >= 22.12.0`; its README states **"Node.js 24.17.0 or newer is
  required"**). Those two statements disagree; treat the README as the operative
  floor and note that a host on **Node 24.10.0 is below it** — upgrade Node
  before blaming the library.
- `@discordjs/voice` 0.19.2 ships `@snazzah/davey ^0.1.9` as a **regular
  dependency** (pre-installed), i.e. DAVE / voice E2EE is handled for you;
  `daveEncryption` defaults to `true` on the connection.
- Opus and FFmpeg are *optional peer* dependencies you must add yourself:
  `@discordjs/opus` (preferred) or `opusscript`; `ffmpeg-static` or system
  FFmpeg. `generateDependencyReport()` is the supported way to prove what is
  actually installed.

### 2.1 Voice *receiving* — the blunt verdict

**It works, it is beta, and it is unsupported-by-Discord by definition.**

The published typings of `@discordjs/voice@0.19.2` contain a real receive path:

```ts
declare class VoiceReceiver {          // JSDoc: "@beta"
  readonly ssrcMap: SSRCMap;
  readonly speaking: SpeakingMap;      // 'start' / 'end' per userId
  subscribe(userId: string, options?: Partial<AudioReceiveStreamOptions>): AudioReceiveStream;
}
declare class VoiceConnection {
  readonly receiver: VoiceReceiver;    // "join with selfDeaf: false for this to work properly"
}
```

with `AudioReceiveStream`, `EndBehaviorType`, and
`createDefaultAudioReceiveStreamOptions` also exported. The package README
advertises "Send and receive\* audio" and then qualifies it:

> `*Audio receive is not documented by Discord so stable support is not guaranteed`

So the honest position:

- **Feasible today in Node** without exotic third-party forks — `joinVoiceChannel({selfDeaf: false})`,
  then `connection.receiver.subscribe(userId)` per speaker, decode Opus.
- **Not a supported contract.** The voice UDP/RTP protocol it relies on is
  undocumented; a Discord-side change can break it in a patch release with no
  deprecation. Do not put it on a critical path without a fallback.
- **`selfDeaf` must be `false`** or you get no inbound audio — the single most
  common "receive doesn't work" cause.
- **DAVE interaction matters**: E2EE defaults on, and receive failure shows up
  as decrypt failures rather than silence; `decryptionFailureTolerance`
  (default 24) triggers a session re-init. Log `voicePrivacyCode` /
  `transitioned` events when debugging.
- **Per-user streams**, not a mixed bus: you must enumerate speakers
  (`connection.receiver.speaking` events) and subscribe individually; a
  single-channel recording requires your own mixing.
- DSharpPlus is a **.NET** library and is not usable from Node at all; its
  receive support is a separate ecosystem question I did not verify and would not
  quote. There is no "DSharpPlus path" for a Node bot.

If a project needs *guaranteed* receive, the defensible alternatives are: record
client-side (a real user client), use stage-channel/voice-message artifacts
instead of live capture, or accept a beta dependency with active monitoring.

---

## 3. Slash commands vs free-text messages

- Free-text handling of ordinary user messages **requires the privileged
  `MESSAGE_CONTENT` intent** (`1 << 15`) — there is no way around it for a bot
  account.
- Without it, apps "receive empty values in fields that contain user-inputted
  content", with four exceptions (`content` is still populated for):
  1. messages **the app itself sent**,
  2. **DMs with the app**,
  3. messages in which the app is **mentioned**,
  4. the target message of a **message context-menu command**.

  Note the exemptions are about *content*: `embeds`, `attachments`, `components`
  are also emptied and `poll` omitted on non-exempt messages.
- Practical consequence: a bot without `MESSAGE_CONTENT` can still run a
  complete slash-command product, including responding to a command whose
  `content` it cannot read. It cannot read ambient chat, cannot see what a user
  typed as a plain message, and cannot inspect attachment metadata on arbitrary
  messages.
- `PATCH`/edit endpoints do not change this; the restriction is on what the
  gateway and REST serialize back to you.

Verdict for a DSH bot: if the product is command-driven (slash commands, buttons,
modals), **skip `MESSAGE_CONTENT` entirely** — smaller privileged surface, no
review exposure, and interactions need no intent at all. Only request it if
ambient chat reading is the actual feature.

---

## 4. Attachments: sizes and formats

Per the current "Uploading Files" section of the API Reference:

- **Per file: `20 MiB` default** for all users, and possibly higher depending on
  Nitro status or the guild's Boost Tier. When working with interactions the
  `attachment_size_limit` field is the maximum of those values — **read that
  field at runtime instead of hardcoding 20 MiB.**
- **Per message: 25 MiB maximum request size** ("The maximum request size when
  sending a message is **25 MiB**", Create Message → Limitations). This is the
  ceiling for the whole multipart body, so several near-20-MiB files in one
  message will fail even though each is individually legal.
- Bots have no Nitro. Their effective per-file limit is whatever the target
  guild allows, which is why guild-boosted servers accept more.
- Attachment **count** per message: the current message docs no longer state a
  number. I did not find an official figure on the pages read, so treat "10 per
  message" as unverified folklore and let the API reject the request.

Formats:

- **Any file type may be attached** — no extension allowlist on general uploads.
- The extension lists you may have seen are for *file-upload component /
  slash-option filtering*, not for sending. Official groups:
  - `image`: `.png .gif .jpg .jpeg .jfif .webp .avif`
  - `video`: `.mp4 .mov .qt .webm`
  - `audio`: `.mp3 .m4a .wav .ogg .opus .flac`
- If you want an uploaded file rendered **inside an embed** via
  `attachment://filename`, only `.jpg .jpeg .png .webp .gif` are accepted.
- Audio that must play in Discord's client is safest as **Ogg/Opus**; for voice
  messages (`IS_VOICE_MESSAGE` flag) the client records Ogg/Opus, and
  `@discordjs/voice` exposes `validateDiscordOpusHead()` because Discord voice
  playback requires a valid Opus head. For plain file drops, `.mp3`, `.m4a`,
  `.wav`, `.flac` all upload fine — they simply are not guaranteed inline
  playback.
- Image/emoji uploads: `.webp`/`.avif` do not round-trip to GIF cleanly; request
  WebP for animated content.

---

## 5. Quick reference for the bot config

```js
// Intents for: guild text (readable), voice state, interactions, no presence/members
const intents = new IntentsBitField([
  GatewayIntentBits.Guilds,            // 1 << 0
  GatewayIntentBits.GuildMessages,     // 1 << 9
  GatewayIntentBits.GuildVoiceStates,  // 1 << 7
  GatewayIntentBits.MessageContent,    // 1 << 15  ← privileged, portal toggle required
]);
// = 33409
```

```js
const connection = joinVoiceChannel({
  channelId, guildId,
  adapterCreator: guild.voiceAdapterCreator,
  selfDeaf: false,          // required for receive
});
const stream = connection.receiver.subscribe(userId, {
  end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
});
// stream is Opus packets; decode with @discordjs/opus or chain prism-media → PCM
```