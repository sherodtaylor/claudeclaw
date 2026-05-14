import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser, isLidUser, isJidGroup } from "baileys";
import type { WASocket, WAMessage, proto } from "baileys";
import type { Boom } from "@hapi/boom";
import { getSettings, loadSettings } from "../config";
import { runUserMessage, ensureProjectClaudeMd, compactCurrentThreadSession } from "../runner";
import { removeThreadSession, peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";

// --- WhatsApp markdown formatter ---
// WhatsApp uses *bold*, _italic_, ~strike~, ```mono```, no HTML.

function markdownToWhatsAppText(text: string): string {
  if (!text) return "";

  // Strip code blocks (preserve content, just remove backtick fences)
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code.trim());
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Strip markdown headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // **bold** → *bold*
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  text = text.replace(/__(.+?)__/g, "*$1*");

  // ~~strikethrough~~ → ~strikethrough~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Bullet lists: keep as-is or normalize
  text = text.replace(/^[-*]\s+/gm, "• ");

  // Restore code blocks as WhatsApp monospace
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`\x00CB${i}\x00`, "```" + codeBlocks[i] + "```");
  }

  return text.trim();
}

// --- Reaction / send-file directive extraction ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

function extractSendFileDirectives(text: string): { cleanedText: string; filePaths: string[] } {
  const filePaths: string[] = [];
  const cleanedText = text
    .replace(/\[send-file:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (candidate) filePaths.push(candidate);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, filePaths };
}

// --- Helpers ---

function extractCommand(text: string): string | null {
  const first = text.trim().split(/\s+/, 1)[0];
  return first.startsWith("/") ? first.toLowerCase() : null;
}

// LID→phone-JID map built from contacts.update events.
// WhatsApp sends the same user as either @s.whatsapp.net or @lid depending on context.
// Without canonicalization, one person gets two Claude sessions — breaking multitenancy.
const lidToPhoneJid = new Map<string, string>();

function canonicalJid(jid: string): string {
  const normalized = jidNormalizedUser(jid);
  if (isLidUser(normalized)) {
    return lidToPhoneJid.get(normalized) ?? normalized;
  }
  return normalized;
}

function jidToPhone(jid: string): string {
  return canonicalJid(jid).split("@")[0];
}

function isGroupJid(jid: string): boolean {
  return isJidGroup(jid) ?? false;
}

const SILENT_LOGGER = {
  level: "silent" as const,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (_obj: unknown, _msg?: string) => {},
  error: (obj: unknown, msg?: string) => console.error("[WhatsApp]", msg ?? obj),
  fatal: (obj: unknown, msg?: string) => console.error("[WhatsApp] fatal:", msg ?? obj),
  child: () => SILENT_LOGGER,
};

// --- Media downloaders ---

async function downloadMediaToFile(
  msg: WAMessage,
  type: "image" | "audio" | "document",
  ext: string
): Promise<string | null> {
  try {
    const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "whatsapp");
    await mkdir(dir, { recursive: true });
    const jid = msg.key?.remoteJid ?? "unknown";
    const id = msg.key?.id ?? Date.now().toString();
    const filename = `${jidToPhone(jid)}-${id}-${Date.now()}${ext}`;
    const localPath = join(dir, filename);
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    await Bun.write(localPath, buffer as Uint8Array);
    return localPath;
  } catch (err) {
    console.error(`[WhatsApp] downloadMedia(${type}) error:`, err);
    return null;
  }
}

// --- Main message handler ---

async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const key = msg.key;
  if (!key) return;

  // Ignore messages from self
  if (key.fromMe) return;

  const senderJid = key.remoteJid;
  if (!senderJid) return;

  const { whatsapp } = getSettings();
  if (!whatsapp) return;

  // Group message handling: skip unless senderJid is allowed, and participant is allowed
  const inGroup = isGroupJid(senderJid);
  const participantJid = inGroup ? (key.participant ?? "") : senderJid;
  const allowedJids = whatsapp.allowedJids ?? [];

  // If allowedJids is non-empty, enforce it — compare via canonical phone number
  if (allowedJids.length > 0) {
    const senderPhone = jidToPhone(participantJid || senderJid);
    const allowed = allowedJids.some(j => jidToPhone(j) === senderPhone);
    if (!allowed) {
      console.log(`[WhatsApp] Ignored message from unauthorized JID: ${participantJid || senderJid}`);
      return;
    }
  }

  // Group messages: skip unless explicitly enabled in config
  if (inGroup && !whatsapp.listenGroups) {
    return;
  }

  const content = msg.message;
  if (!content) return;

  // Extract text
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    "";

  const hasImage = Boolean(content.imageMessage);
  const hasAudio = Boolean(content.audioMessage);
  const hasDocument = Boolean(content.documentMessage);
  const hasVideo = Boolean(content.videoMessage);

  if (!text.trim() && !hasImage && !hasAudio && !hasDocument && !hasVideo) return;

  const label = jidToPhone(participantJid || senderJid);
  const replyJid = senderJid; // always reply to the chat, not the participant
  // Canonical JID resolves LIDs to phone JIDs so the same person always maps to one session
  const sessionKey = `wa:${canonicalJid(participantJid || senderJid)}`;

  // Typing indicator
  await sock.sendPresenceUpdate("composing", replyJid).catch(() => {});

  const command = text ? extractCommand(text) : null;

  if (command === "/start") {
    await sock.sendMessage(replyJid, { text: "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session." });
    await sock.sendPresenceUpdate("available", replyJid).catch(() => {});
    return;
  }

  if (command === "/reset") {
    await removeThreadSession(sessionKey);
    await sock.sendMessage(replyJid, { text: "Session reset. Next message starts fresh." });
    await sock.sendPresenceUpdate("available", replyJid).catch(() => {});
    return;
  }

  if (command === "/compact") {
    await sock.sendMessage(replyJid, { text: "⏳ Compacting session..." });
    const result = await compactCurrentThreadSession(sessionKey);
    await sock.sendMessage(replyJid, { text: result.message });
    await sock.sendPresenceUpdate("available", replyJid).catch(() => {});
    return;
  }

  if (command === "/status") {
    const session = await peekThreadSession(sessionKey);
    if (!session) {
      await sock.sendMessage(replyJid, { text: "No active session." });
    } else {
      const settings = getSettings();
      const lines = [
        "*Session Status*",
        `Session: \`${session.sessionId.slice(0, 8)}\``,
        `Turns: ${session.turnCount ?? 0}`,
        `Model: ${settings.model || "default"}`,
        `Security: ${settings.security.level}`,
        `Created: ${session.createdAt}`,
        `Last used: ${session.lastUsedAt}`,
      ];
      await sock.sendMessage(replyJid, { text: lines.join("\n") });
    }
    await sock.sendPresenceUpdate("available", replyJid).catch(() => {});
    return;
  }

  const mediaParts = [hasImage ? "image" : "", hasAudio ? "voice" : "", hasDocument ? "doc" : "", hasVideo ? "video" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(`[${new Date().toLocaleTimeString()}] WhatsApp ${label}${mediaSuffix}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  try {
    // Skill routing
    let skillContext: string | null = null;
    if (command && command !== "/start" && command !== "/reset" && command !== "/compact" && command !== "/status") {
      try {
        skillContext = await resolveSkillPrompt(command);
      } catch {
        // ignore
      }
    }

    // Download media
    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;
    let documentPath: string | null = null;
    let documentName: string | null = null;

    if (hasImage) {
      imagePath = await downloadMediaToFile(msg, "image", ".jpg");
    }

    if (hasAudio) {
      voicePath = await downloadMediaToFile(msg, "audio", ".ogg");
      if (voicePath) {
        try {
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: false,
            log: () => {},
          });
        } catch (err) {
          console.error(`[WhatsApp] Transcription failed for ${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    if (hasDocument) {
      const docMsg = content.documentMessage;
      const docName = docMsg?.fileName ?? "document";
      const docExt = extname(docName) || ".bin";
      documentPath = await downloadMediaToFile(msg, "document", docExt);
      documentName = docName;
    }

    // Build prompt
    const promptParts = [`[WhatsApp from ${label}]`];
    if (inGroup) promptParts.push(`[group:${jidToPhone(senderJid)}]`);

    if (skillContext) {
      const args = text.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (text.trim()) {
      promptParts.push(`Message: ${text}`);
    }

    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }

    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (hasAudio) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.");
    }

    if (documentPath && documentName) {
      promptParts.push(`Document path: ${documentPath}`);
      promptParts.push(`Original filename: ${documentName}`);
      promptParts.push("The user attached a document. Read and process this file directly.");
    } else if (hasDocument) {
      promptParts.push("The user attached a document, but downloading it failed. Respond and ask them to resend.");
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("whatsapp", prefixedPrompt, sessionKey);

    if (result.exitCode !== 0) {
      await sock.sendMessage(replyJid, { text: `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}` });
    } else {
      const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(result.stdout || "");
      const { cleanedText, filePaths } = extractSendFileDirectives(afterReact);

      if (reactionEmoji && key) {
        await sock.sendMessage(replyJid, {
          react: { text: reactionEmoji, key },
        }).catch((err) => {
          console.error(`[WhatsApp] Reaction failed for ${label}: ${err instanceof Error ? err.message : err}`);
        });
      }

      if (cleanedText) {
        const MAX_LEN = 4096;
        const waText = markdownToWhatsAppText(cleanedText);
        for (let i = 0; i < waText.length; i += MAX_LEN) {
          await sock.sendMessage(replyJid, { text: waText.slice(i, i + MAX_LEN) });
        }
      }

      for (const fp of filePaths) {
        if (!existsSync(fp)) {
          await sock.sendMessage(replyJid, { text: `File not found: ${fp.split("/").pop()}` });
          continue;
        }
        try {
          const fileName = fp.split("/").pop() ?? "file";
          const fileData = await Bun.file(fp).arrayBuffer();
          await sock.sendMessage(replyJid, {
            document: Buffer.from(fileData),
            fileName,
            mimetype: "application/octet-stream",
          });
        } catch (err) {
          console.error(`[WhatsApp] sendDocument failed for ${label}: ${err instanceof Error ? err.message : err}`);
          await sock.sendMessage(replyJid, { text: `Failed to send file: ${fp.split("/").pop()}` });
        }
      }

      if (!cleanedText && filePaths.length === 0) {
        await sock.sendMessage(replyJid, { text: "(empty response)" });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WhatsApp] Error for ${label}: ${errMsg}`);
    await sock.sendMessage(replyJid, { text: `Error: ${errMsg}` });
  } finally {
    await sock.sendPresenceUpdate("available", replyJid).catch(() => {});
  }
}

// --- Connection loop ---

async function connect(authDir: string): Promise<void> {
  while (true) {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: SILENT_LOGGER as any,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    // Build LID→phone-JID mapping so canonicalJid() can resolve @lid participants
    sock.ev.on("contacts.update", (updates) => {
      for (const contact of updates) {
        if (contact.lid && contact.phoneNumber) {
          lidToPhoneJid.set(jidNormalizedUser(contact.lid), jidNormalizedUser(contact.phoneNumber));
        }
      }
    });

    await new Promise<void>((resolve) => {
      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          console.log("[WhatsApp] Connected.");
          const { whatsapp } = getSettings();
          const allowed = whatsapp?.allowedJids ?? [];
          console.log(`  Allowed JIDs: ${allowed.length === 0 ? "all" : allowed.join(", ")}`);
          console.log(`  Group messages: ${whatsapp?.listenGroups ? "enabled" : "disabled"}`);
        }

        if (connection === "close") {
          const boom = lastDisconnect?.error as Boom | undefined;
          const code = boom?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;

          if (code === DisconnectReason.loggedOut) {
            console.error("[WhatsApp] Logged out — wipe auth dir and re-scan QR to reconnect.");
          } else {
            console.warn(`[WhatsApp] Disconnected (code=${code}) — reconnecting...`);
          }

          resolve();
          if (!shouldReconnect) {
            process.exit(1);
          }
        }
      });

      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          handleMessage(sock, msg).catch((err) => {
            console.error("[WhatsApp] Unhandled:", err);
          });
        }
      });
    });

    console.log("[WhatsApp] Reconnecting in 5s...");
    await Bun.sleep(5000);
  }
}

// --- Exports ---

/** Standalone entry point (bun run src/index.ts whatsapp) */
export async function whatsapp() {
  await loadSettings();
  await ensureProjectClaudeMd();

  const { whatsapp: cfg } = getSettings();
  if (!cfg) {
    console.error("[WhatsApp] No 'whatsapp' config found in settings.json. Add { allowedJids: [], authDir: '.claude/claudeclaw/whatsapp-auth' }");
    process.exit(1);
  }

  const authDir = cfg.authDir || join(process.cwd(), ".claude", "claudeclaw", "whatsapp-auth");
  await mkdir(authDir, { recursive: true });

  console.log("WhatsApp bot starting...");
  console.log(`  Auth dir: ${authDir}`);

  await connect(authDir);
}
