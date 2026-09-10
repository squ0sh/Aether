import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

const conversationsRoot = join(process.env.AETHER_DATA_DIR || join(process.cwd(), "data"), "conversations");
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateId(id) {
  if (!idPattern.test(id || "")) throw new Error("Invalid conversation ID");
  return id;
}

function conversationPath(id, root = conversationsRoot) {
  return join(root, `${validateId(id)}.json`);
}

async function saveConversation(conversation, root = conversationsRoot) {
  const path = conversationPath(conversation.id, root);
  const incoming = `${path}.incoming-${process.pid}`;
  await mkdir(root, { recursive: true });
  try {
    await writeFile(incoming, `${JSON.stringify(conversation, null, 2)}\n`, { mode: 0o600 });
    await rename(incoming, path);
  } finally { await rm(incoming, { force: true }); }
  return conversation;
}

async function createConversation(title = null, root = conversationsRoot) {
  const now = new Date().toISOString();
  return await saveConversation({
    id: randomUUID(),
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 80) : "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: []
  }, root);
}

async function getConversation(id, root = conversationsRoot) {
  try { return JSON.parse(await readFile(conversationPath(id, root), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error("Conversation not found");
      missing.statusCode = 404;
      throw missing;
    }
    throw error;
  }
}

async function appendMessage(id, role, content, root = conversationsRoot) {
  if (!["user", "assistant"].includes(role) || typeof content !== "string" || !content.trim()) throw new Error("Invalid conversation message");
  const conversation = await getConversation(id, root);
  conversation.messages.push({ id: randomUUID(), role, content, createdAt: new Date().toISOString() });
  conversation.updatedAt = new Date().toISOString();
  if (conversation.title === "New conversation" && role === "user") conversation.title = content.trim().replace(/\s+/g, " ").slice(0, 80);
  return await saveConversation(conversation, root);
}

async function listConversations(root = conversationsRoot) {
  let files;
  try { files = await readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const conversations = [];
  for (const file of files.filter((name) => idPattern.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))) {
    try {
      const item = JSON.parse(await readFile(join(root, file), "utf8"));
      conversations.push({ id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, messageCount: item.messages.length });
    } catch { /* Ignore incomplete/corrupt individual records in the listing. */ }
  }
  return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function deleteConversation(id, root = conversationsRoot) {
  await rm(conversationPath(id, root), { force: true });
}

export { appendMessage, createConversation, deleteConversation, getConversation, listConversations };
