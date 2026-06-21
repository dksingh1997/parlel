import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TelegramServer } from "../services/telegram/src/server.js";

const PORT = 14656;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "123456789:parlel-test-bot-token";

type Json = Record<string, any>;

/**
 * A faithful, dependency-free re-implementation of how `node-telegram-bot-api`
 * dispatches requests. The real client:
 *   - POSTs to `${baseApiUrl}/bot${token}/${methodName}`
 *   - serializes params as application/x-www-form-urlencoded (objects are
 *     JSON-stringified into a single field)
 *   - parses the JSON response: on `ok === true` it resolves with `result`,
 *     on `ok === false` it throws a `TelegramError` carrying error_code +
 *     description.
 * This mirror lets us exercise the exact protocol with zero external deps.
 */
class TelegramError extends Error {
  code: string;
  response: { statusCode: number; body: any };
  constructor(body: any, statusCode: number) {
    super(`ETELEGRAM: ${body.error_code} ${body.description}`);
    this.code = "ETELEGRAM";
    this.response = { statusCode, body };
  }
}

class TelegramBotSim {
  constructor(private token: string, private baseApiUrl = BASE_URL) {}

  async _request(methodName: string, form: Json = {}): Promise<any> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined || v === null) continue;
      params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(`${this.baseApiUrl}/bot${this.token}/${methodName}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await res.json();
    if (!data.ok) throw new TelegramError(data, res.status);
    return data.result;
  }

  getMe = () => this._request("getMe");
  logOut = () => this._request("logOut");
  close = () => this._request("close");
  getUpdates = (o: Json = {}) => this._request("getUpdates", o);
  setWebHook = (url: string, o: Json = {}) => this._request("setWebhook", { url, ...o });
  deleteWebHook = (o: Json = {}) => this._request("deleteWebhook", o);
  getWebHookInfo = () => this._request("getWebhookInfo");
  sendMessage = (chatId: any, text: string, o: Json = {}) => this._request("sendMessage", { chat_id: chatId, text, ...o });
  forwardMessage = (chatId: any, fromChatId: any, messageId: number, o: Json = {}) =>
    this._request("forwardMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...o });
  copyMessage = (chatId: any, fromChatId: any, messageId: number, o: Json = {}) =>
    this._request("copyMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...o });
  sendPhoto = (chatId: any, photo: any, o: Json = {}) => this._request("sendPhoto", { chat_id: chatId, photo, ...o });
  sendAudio = (chatId: any, audio: any, o: Json = {}) => this._request("sendAudio", { chat_id: chatId, audio, ...o });
  sendDocument = (chatId: any, doc: any, o: Json = {}) => this._request("sendDocument", { chat_id: chatId, document: doc, ...o });
  sendVideo = (chatId: any, v: any, o: Json = {}) => this._request("sendVideo", { chat_id: chatId, video: v, ...o });
  sendAnimation = (chatId: any, a: any, o: Json = {}) => this._request("sendAnimation", { chat_id: chatId, animation: a, ...o });
  sendVoice = (chatId: any, v: any, o: Json = {}) => this._request("sendVoice", { chat_id: chatId, voice: v, ...o });
  sendVideoNote = (chatId: any, v: any, o: Json = {}) => this._request("sendVideoNote", { chat_id: chatId, video_note: v, ...o });
  sendMediaGroup = (chatId: any, media: any[], o: Json = {}) => this._request("sendMediaGroup", { chat_id: chatId, media, ...o });
  sendLocation = (chatId: any, lat: number, lon: number, o: Json = {}) =>
    this._request("sendLocation", { chat_id: chatId, latitude: lat, longitude: lon, ...o });
  editMessageLiveLocation = (lat: number, lon: number, o: Json = {}) =>
    this._request("editMessageLiveLocation", { latitude: lat, longitude: lon, ...o });
  stopMessageLiveLocation = (o: Json = {}) => this._request("stopMessageLiveLocation", o);
  sendVenue = (chatId: any, lat: number, lon: number, title: string, address: string, o: Json = {}) =>
    this._request("sendVenue", { chat_id: chatId, latitude: lat, longitude: lon, title, address, ...o });
  sendContact = (chatId: any, phone: string, firstName: string, o: Json = {}) =>
    this._request("sendContact", { chat_id: chatId, phone_number: phone, first_name: firstName, ...o });
  sendPoll = (chatId: any, question: string, options: any[], o: Json = {}) =>
    this._request("sendPoll", { chat_id: chatId, question, options, ...o });
  stopPoll = (chatId: any, messageId: number, o: Json = {}) =>
    this._request("stopPoll", { chat_id: chatId, message_id: messageId, ...o });
  sendDice = (chatId: any, o: Json = {}) => this._request("sendDice", { chat_id: chatId, ...o });
  sendChatAction = (chatId: any, action: string, o: Json = {}) =>
    this._request("sendChatAction", { chat_id: chatId, action, ...o });
  getUserProfilePhotos = (userId: number, o: Json = {}) => this._request("getUserProfilePhotos", { user_id: userId, ...o });
  getFile = (fileId: string) => this._request("getFile", { file_id: fileId });
  getFileLink = async (fileId: string) => {
    const file = await this.getFile(fileId);
    return `${this.baseApiUrl}/file/bot${this.token}/${file.file_path}`;
  };
  banChatMember = (chatId: any, userId: number, o: Json = {}) => this._request("banChatMember", { chat_id: chatId, user_id: userId, ...o });
  kickChatMember = (chatId: any, userId: number, o: Json = {}) => this._request("kickChatMember", { chat_id: chatId, user_id: userId, ...o });
  unbanChatMember = (chatId: any, userId: number, o: Json = {}) => this._request("unbanChatMember", { chat_id: chatId, user_id: userId, ...o });
  restrictChatMember = (chatId: any, userId: number, o: Json = {}) => this._request("restrictChatMember", { chat_id: chatId, user_id: userId, ...o });
  promoteChatMember = (chatId: any, userId: number, o: Json = {}) => this._request("promoteChatMember", { chat_id: chatId, user_id: userId, ...o });
  setChatAdministratorCustomTitle = (chatId: any, userId: number, title: string) =>
    this._request("setChatAdministratorCustomTitle", { chat_id: chatId, user_id: userId, custom_title: title });
  setChatPermissions = (chatId: any, perms: Json) => this._request("setChatPermissions", { chat_id: chatId, permissions: perms });
  exportChatInviteLink = (chatId: any) => this._request("exportChatInviteLink", { chat_id: chatId });
  createChatInviteLink = (chatId: any, o: Json = {}) => this._request("createChatInviteLink", { chat_id: chatId, ...o });
  editChatInviteLink = (chatId: any, inviteLink: string, o: Json = {}) =>
    this._request("editChatInviteLink", { chat_id: chatId, invite_link: inviteLink, ...o });
  revokeChatInviteLink = (chatId: any, inviteLink: string) =>
    this._request("revokeChatInviteLink", { chat_id: chatId, invite_link: inviteLink });
  approveChatJoinRequest = (chatId: any, userId: number) => this._request("approveChatJoinRequest", { chat_id: chatId, user_id: userId });
  declineChatJoinRequest = (chatId: any, userId: number) => this._request("declineChatJoinRequest", { chat_id: chatId, user_id: userId });
  setChatTitle = (chatId: any, title: string) => this._request("setChatTitle", { chat_id: chatId, title });
  setChatDescription = (chatId: any, description: string) => this._request("setChatDescription", { chat_id: chatId, description });
  deleteChatPhoto = (chatId: any) => this._request("deleteChatPhoto", { chat_id: chatId });
  pinChatMessage = (chatId: any, messageId: number, o: Json = {}) => this._request("pinChatMessage", { chat_id: chatId, message_id: messageId, ...o });
  unpinChatMessage = (chatId: any, o: Json = {}) => this._request("unpinChatMessage", { chat_id: chatId, ...o });
  unpinAllChatMessages = (chatId: any) => this._request("unpinAllChatMessages", { chat_id: chatId });
  leaveChat = (chatId: any) => this._request("leaveChat", { chat_id: chatId });
  getChat = (chatId: any) => this._request("getChat", { chat_id: chatId });
  getChatAdministrators = (chatId: any) => this._request("getChatAdministrators", { chat_id: chatId });
  getChatMemberCount = (chatId: any) => this._request("getChatMemberCount", { chat_id: chatId });
  getChatMembersCount = (chatId: any) => this._request("getChatMembersCount", { chat_id: chatId });
  getChatMember = (chatId: any, userId: number) => this._request("getChatMember", { chat_id: chatId, user_id: userId });
  setChatStickerSet = (chatId: any, name: string) => this._request("setChatStickerSet", { chat_id: chatId, sticker_set_name: name });
  deleteChatStickerSet = (chatId: any) => this._request("deleteChatStickerSet", { chat_id: chatId });
  answerCallbackQuery = (id: string, o: Json = {}) => this._request("answerCallbackQuery", { callback_query_id: id, ...o });
  answerInlineQuery = (id: string, results: any[], o: Json = {}) => this._request("answerInlineQuery", { inline_query_id: id, results, ...o });
  setMyCommands = (commands: any[], o: Json = {}) => this._request("setMyCommands", { commands, ...o });
  getMyCommands = (o: Json = {}) => this._request("getMyCommands", o);
  deleteMyCommands = (o: Json = {}) => this._request("deleteMyCommands", o);
  setMyDescription = (o: Json = {}) => this._request("setMyDescription", o);
  getMyDescription = (o: Json = {}) => this._request("getMyDescription", o);
  setMyShortDescription = (o: Json = {}) => this._request("setMyShortDescription", o);
  getMyShortDescription = (o: Json = {}) => this._request("getMyShortDescription", o);
  setMyName = (o: Json = {}) => this._request("setMyName", o);
  getMyName = (o: Json = {}) => this._request("getMyName", o);
  editMessageText = (text: string, o: Json = {}) => this._request("editMessageText", { text, ...o });
  editMessageCaption = (caption: string, o: Json = {}) => this._request("editMessageCaption", { caption, ...o });
  editMessageReplyMarkup = (markup: Json, o: Json = {}) => this._request("editMessageReplyMarkup", { reply_markup: markup, ...o });
  editMessageMedia = (media: Json, o: Json = {}) => this._request("editMessageMedia", { media, ...o });
  deleteMessage = (chatId: any, messageId: number) => this._request("deleteMessage", { chat_id: chatId, message_id: messageId });
  sendSticker = (chatId: any, sticker: any, o: Json = {}) => this._request("sendSticker", { chat_id: chatId, sticker, ...o });
  getStickerSet = (name: string) => this._request("getStickerSet", { name });
  uploadStickerFile = (userId: number, o: Json = {}) => this._request("uploadStickerFile", { user_id: userId, ...o });
  createNewStickerSet = (o: Json) => this._request("createNewStickerSet", o);
  addStickerToSet = (o: Json) => this._request("addStickerToSet", o);
  setStickerPositionInSet = (sticker: string, position: number) => this._request("setStickerPositionInSet", { sticker, position });
  deleteStickerFromSet = (sticker: string) => this._request("deleteStickerFromSet", { sticker });
  setMessageReaction = (chatId: any, messageId: number, reaction: any[]) =>
    this._request("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction });
  sendGame = (chatId: any, gameShortName: string, o: Json = {}) =>
    this._request("sendGame", { chat_id: chatId, game_short_name: gameShortName, ...o });
  setGameScore = (userId: number, score: number, o: Json = {}) => this._request("setGameScore", { user_id: userId, score, ...o });
  getGameHighScores = (userId: number, o: Json = {}) => this._request("getGameHighScores", { user_id: userId, ...o });
  banChatSenderChat = (chatId: any, senderChatId: number) => this._request("banChatSenderChat", { chat_id: chatId, sender_chat_id: senderChatId });
  unbanChatSenderChat = (chatId: any, senderChatId: number) => this._request("unbanChatSenderChat", { chat_id: chatId, sender_chat_id: senderChatId });
  sendInvoice = (chatId: any, title: string, description: string, payload: string, providerToken: string, currency: string, prices: any[], o: Json = {}) =>
    this._request("sendInvoice", { chat_id: chatId, title, description, payload, provider_token: providerToken, currency, prices, ...o });
  answerShippingQuery = (id: string, ok: boolean, o: Json = {}) => this._request("answerShippingQuery", { shipping_query_id: id, ok, ...o });
  answerPreCheckoutQuery = (id: string, ok: boolean, o: Json = {}) => this._request("answerPreCheckoutQuery", { pre_checkout_query_id: id, ok, ...o });
  setChatMenuButton = (o: Json = {}) => this._request("setChatMenuButton", o);
  getChatMenuButton = (o: Json = {}) => this._request("getChatMenuButton", o);
  setMyDefaultAdministratorRights = (o: Json = {}) => this._request("setMyDefaultAdministratorRights", o);
  getMyDefaultAdministratorRights = (o: Json = {}) => this._request("getMyDefaultAdministratorRights", o);
}

/** Raw HTTP helper for infra/control endpoints. */
async function http(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const PRIVATE_CHAT = 555000111;
const GROUP_CHAT = -1001000000001;

describe("Telegram Service", () => {
  let server: TelegramServer;
  let bot: TelegramBotSim;

  beforeAll(async () => {
    server = new TelegramServer(PORT);
    await server.start();
    bot = new TelegramBotSim(TOKEN);
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await http("POST", "/__parlel/reset");
  });

  // -------------------------------------------------------------------------
  describe("Server lifecycle & infra", () => {
    it("exposes the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("responds to health check", async () => {
      const r = await http("GET", "/health");
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("ok");
    });

    it("responds to root metadata", async () => {
      const r = await http("GET", "/");
      expect(r.status).toBe(200);
      expect(r.body.name).toBe("telegram");
      expect(r.body.protocol).toBe("telegram-bot-api");
    });

    it("rejects requests with an unknown token", async () => {
      const res = await fetch(`${BASE_URL}/botWRONG-TOKEN/getMe`, { method: "POST" });
      const data = await res.json();
      expect(res.status).toBe(401);
      expect(data.ok).toBe(false);
      expect(data.error_code).toBe(401);
    });

    it("returns 404 for an unknown method", async () => {
      const res = await fetch(`${BASE_URL}/bot${TOKEN}/notARealMethod`, { method: "POST" });
      const data = await res.json();
      expect(res.status).toBe(404);
      expect(data.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("Bot identity & connection", () => {
    it("getMe returns the bot user", async () => {
      const me = await bot.getMe();
      expect(me.is_bot).toBe(true);
      expect(me.username).toBe("parlelbot");
      expect(me.id).toBe(123456789);
    });

    it("logOut returns true", async () => {
      expect(await bot.logOut()).toBe(true);
    });

    it("close returns true", async () => {
      expect(await bot.close()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Webhooks", () => {
    it("setWebHook configures a url", async () => {
      expect(await bot.setWebHook("https://example.com/hook", { max_connections: 10 })).toBe(true);
      const info = await bot.getWebHookInfo();
      expect(info.url).toBe("https://example.com/hook");
      expect(info.max_connections).toBe(10);
    });

    it("deleteWebHook clears the url", async () => {
      await bot.setWebHook("https://example.com/hook");
      expect(await bot.deleteWebHook()).toBe(true);
      const info = await bot.getWebHookInfo();
      expect(info.url).toBe("");
    });

    it("getWebHookInfo reflects pending updates", async () => {
      await http("POST", "/__parlel/message", { text: "hi" });
      const info = await bot.getWebHookInfo();
      expect(info.pending_update_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("getUpdates (long-poll)", () => {
    it("returns injected incoming messages", async () => {
      await http("POST", "/__parlel/message", { text: "/start" });
      const updates = await bot.getUpdates();
      expect(updates.length).toBe(1);
      expect(updates[0].message.text).toBe("/start");
      expect(updates[0].message.entities[0].type).toBe("bot_command");
    });

    it("confirms updates via offset", async () => {
      await http("POST", "/__parlel/message", { text: "one" });
      await http("POST", "/__parlel/message", { text: "two" });
      const updates = await bot.getUpdates();
      expect(updates.length).toBe(2);
      const lastId = updates[updates.length - 1].update_id;
      const after = await bot.getUpdates({ offset: lastId + 1 });
      expect(after.length).toBe(0);
    });

    it("honors limit", async () => {
      await http("POST", "/__parlel/message", { text: "a" });
      await http("POST", "/__parlel/message", { text: "b" });
      await http("POST", "/__parlel/message", { text: "c" });
      const updates = await bot.getUpdates({ limit: 2 });
      expect(updates.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("sendMessage", () => {
    it("sends a text message", async () => {
      const msg = await bot.sendMessage(PRIVATE_CHAT, "Hello world");
      expect(msg.text).toBe("Hello world");
      expect(msg.chat.id).toBe(PRIVATE_CHAT);
      expect(msg.from.id).toBe(123456789);
      expect(typeof msg.message_id).toBe("number");
    });

    it("accepts @username chat ids", async () => {
      const msg = await bot.sendMessage("@alice", "via username");
      expect(msg.chat.username).toBe("alice");
    });

    it("detects bot_command entities", async () => {
      const msg = await bot.sendMessage(PRIVATE_CHAT, "/help me");
      expect(msg.entities[0]).toMatchObject({ type: "bot_command", offset: 0 });
    });

    it("preserves reply_markup (inline keyboard)", async () => {
      const markup = { inline_keyboard: [[{ text: "Click", callback_data: "x" }]] };
      const msg = await bot.sendMessage(PRIVATE_CHAT, "with kb", { reply_markup: markup });
      expect(msg.reply_markup.inline_keyboard[0][0].text).toBe("Click");
    });

    it("supports reply_to_message_id", async () => {
      const first = await bot.sendMessage(PRIVATE_CHAT, "original");
      const reply = await bot.sendMessage(PRIVATE_CHAT, "reply", { reply_to_message_id: first.message_id });
      expect(reply.reply_to_message.message_id).toBe(first.message_id);
    });

    it("rejects empty text", async () => {
      await expect(bot.sendMessage(PRIVATE_CHAT, "")).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });

    it("rejects an unknown chat", async () => {
      await expect(bot.sendMessage(999999999, "hi")).rejects.toMatchObject({
        response: { body: { ok: false, error_code: 400 } },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("forwardMessage & copyMessage", () => {
    it("forwards a message", async () => {
      const original = await bot.sendMessage(GROUP_CHAT, "forward me");
      const fwd = await bot.forwardMessage(PRIVATE_CHAT, GROUP_CHAT, original.message_id);
      expect(fwd.forward_from_chat.id).toBe(GROUP_CHAT);
      expect(fwd.forward_from_message_id).toBe(original.message_id);
      expect(fwd.text).toBe("forward me");
    });

    it("copies a message and returns a MessageId", async () => {
      const original = await bot.sendMessage(GROUP_CHAT, "copy me");
      const copy = await bot.copyMessage(PRIVATE_CHAT, GROUP_CHAT, original.message_id);
      expect(typeof copy.message_id).toBe("number");
      expect(copy.message_id).not.toBe(original.message_id);
    });

    it("errors forwarding a missing message", async () => {
      await expect(bot.forwardMessage(PRIVATE_CHAT, GROUP_CHAT, 999999)).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("Media messages", () => {
    it("sendPhoto returns photo sizes", async () => {
      const msg = await bot.sendPhoto(PRIVATE_CHAT, "https://example.com/a.jpg", { caption: "pic" });
      expect(Array.isArray(msg.photo)).toBe(true);
      expect(msg.photo.length).toBeGreaterThanOrEqual(1);
      expect(msg.caption).toBe("pic");
    });

    it("sendAudio returns audio with duration/performer", async () => {
      const msg = await bot.sendAudio(PRIVATE_CHAT, "file_id", { performer: "Band", title: "Song", duration: 200 });
      expect(msg.audio.performer).toBe("Band");
      expect(msg.audio.duration).toBe(200);
    });

    it("sendDocument returns document with file_name", async () => {
      const msg = await bot.sendDocument(PRIVATE_CHAT, "report.pdf");
      expect(msg.document.file_id).toContain("parlel-document");
    });

    it("sendVideo returns video dims", async () => {
      const msg = await bot.sendVideo(PRIVATE_CHAT, "v");
      expect(msg.video.width).toBe(320);
    });

    it("sendAnimation works", async () => {
      const msg = await bot.sendAnimation(PRIVATE_CHAT, "a.gif");
      expect(msg.animation.file_id).toContain("parlel-animation");
    });

    it("sendVoice works", async () => {
      const msg = await bot.sendVoice(PRIVATE_CHAT, "v.ogg", { duration: 5 });
      expect(msg.voice.duration).toBe(5);
    });

    it("sendVideoNote works", async () => {
      const msg = await bot.sendVideoNote(PRIVATE_CHAT, "vn");
      expect(msg.video_note.file_id).toContain("parlel-video_note");
    });

    it("sendMediaGroup returns an array of messages", async () => {
      const group = await bot.sendMediaGroup(PRIVATE_CHAT, [
        { type: "photo", media: "a.jpg" },
        { type: "photo", media: "b.jpg", caption: "two" },
      ]);
      expect(Array.isArray(group)).toBe(true);
      expect(group.length).toBe(2);
      expect(group[1].caption).toBe("two");
    });

    it("sendSticker works", async () => {
      const msg = await bot.sendSticker(PRIVATE_CHAT, "sticker_file_id");
      expect(msg.sticker.width).toBe(512);
    });
  });

  // -------------------------------------------------------------------------
  describe("Location, venue, contact, poll, dice", () => {
    it("sendLocation works", async () => {
      const msg = await bot.sendLocation(PRIVATE_CHAT, 51.5, -0.12);
      expect(msg.location.latitude).toBe(51.5);
    });

    it("editMessageLiveLocation + stop", async () => {
      const msg = await bot.sendLocation(PRIVATE_CHAT, 1, 1, { live_period: 600 });
      const edited = await bot.editMessageLiveLocation(2, 2, { chat_id: PRIVATE_CHAT, message_id: msg.message_id });
      expect(edited.location.latitude).toBe(2);
      const stopped = await bot.stopMessageLiveLocation({ chat_id: PRIVATE_CHAT, message_id: msg.message_id });
      expect(stopped.message_id).toBe(msg.message_id);
    });

    it("sendVenue works", async () => {
      const msg = await bot.sendVenue(PRIVATE_CHAT, 40, -73, "MoMA", "11 W 53rd");
      expect(msg.venue.title).toBe("MoMA");
    });

    it("sendContact works", async () => {
      const msg = await bot.sendContact(PRIVATE_CHAT, "+15551234", "Jane", { last_name: "Doe" });
      expect(msg.contact.phone_number).toBe("+15551234");
      expect(msg.contact.last_name).toBe("Doe");
    });

    it("sendPoll + stopPoll", async () => {
      const msg = await bot.sendPoll(PRIVATE_CHAT, "Fav?", ["A", "B", "C"]);
      expect(msg.poll.options.length).toBe(3);
      const stopped = await bot.stopPoll(PRIVATE_CHAT, msg.message_id);
      expect(stopped.is_closed).toBe(true);
    });

    it("sendPoll rejects <2 options", async () => {
      await expect(bot.sendPoll(PRIVATE_CHAT, "Q", ["only"])).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });

    it("sendDice works", async () => {
      const msg = await bot.sendDice(PRIVATE_CHAT, { emoji: "🎯" });
      expect(msg.dice.emoji).toBe("🎯");
      expect(typeof msg.dice.value).toBe("number");
    });

    it("sendChatAction works", async () => {
      expect(await bot.sendChatAction(PRIVATE_CHAT, "typing")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Files", () => {
    it("getUserProfilePhotos returns photos", async () => {
      const photos = await bot.getUserProfilePhotos(PRIVATE_CHAT);
      expect(photos.total_count).toBe(1);
      expect(photos.photos[0][0].file_id).toContain("parlel-photo");
    });

    it("getFile resolves a sent file's path", async () => {
      const msg = await bot.sendDocument(PRIVATE_CHAT, "data.bin");
      const file = await bot.getFile(msg.document.file_id);
      expect(file.file_path).toBeTruthy();
      expect(file.file_id).toBe(msg.document.file_id);
    });

    it("getFileLink builds a downloadable url that serves bytes", async () => {
      const msg = await bot.sendDocument(PRIVATE_CHAT, "data.bin");
      const link = await bot.getFileLink(msg.document.file_id);
      const res = await fetch(link);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("parlel-file:");
    });
  });

  // -------------------------------------------------------------------------
  describe("Chat member management", () => {
    it("banChatMember & unbanChatMember", async () => {
      expect(await bot.banChatMember(GROUP_CHAT, PRIVATE_CHAT)).toBe(true);
      const banned = await bot.getChatMember(GROUP_CHAT, PRIVATE_CHAT);
      expect(banned.status).toBe("kicked");
      expect(await bot.unbanChatMember(GROUP_CHAT, PRIVATE_CHAT)).toBe(true);
    });

    it("kickChatMember alias works", async () => {
      expect(await bot.kickChatMember(GROUP_CHAT, PRIVATE_CHAT)).toBe(true);
    });

    it("restrictChatMember sets restricted status", async () => {
      await bot.restrictChatMember(GROUP_CHAT, PRIVATE_CHAT, { permissions: { can_send_messages: false } });
      const m = await bot.getChatMember(GROUP_CHAT, PRIVATE_CHAT);
      expect(m.status).toBe("restricted");
    });

    it("promoteChatMember + custom title", async () => {
      await bot.promoteChatMember(GROUP_CHAT, PRIVATE_CHAT, { can_delete_messages: true });
      const m = await bot.getChatMember(GROUP_CHAT, PRIVATE_CHAT);
      expect(m.status).toBe("administrator");
      expect(m.can_delete_messages).toBe(true);
      expect(await bot.setChatAdministratorCustomTitle(GROUP_CHAT, PRIVATE_CHAT, "Boss")).toBe(true);
      const m2 = await bot.getChatMember(GROUP_CHAT, PRIVATE_CHAT);
      expect(m2.custom_title).toBe("Boss");
    });

    it("setChatPermissions works", async () => {
      expect(await bot.setChatPermissions(GROUP_CHAT, { can_send_messages: true })).toBe(true);
    });

    it("getChatMember returns 'left' for unknown user", async () => {
      const m = await bot.getChatMember(GROUP_CHAT, 424242);
      expect(m.status).toBe("left");
    });
  });

  // -------------------------------------------------------------------------
  describe("Invite links", () => {
    it("exportChatInviteLink returns a url string", async () => {
      const link = await bot.exportChatInviteLink(GROUP_CHAT);
      expect(typeof link).toBe("string");
      expect(link).toContain("t.me");
    });

    it("create / edit / revoke invite link", async () => {
      const link = await bot.createChatInviteLink(GROUP_CHAT, { name: "promo", member_limit: 5 });
      expect(link.name).toBe("promo");
      expect(link.member_limit).toBe(5);
      const edited = await bot.editChatInviteLink(GROUP_CHAT, link.invite_link, { member_limit: 10 });
      expect(edited.member_limit).toBe(10);
      const revoked = await bot.revokeChatInviteLink(GROUP_CHAT, link.invite_link);
      expect(revoked.is_revoked).toBe(true);
    });

    it("approve / decline join request", async () => {
      expect(await bot.approveChatJoinRequest(GROUP_CHAT, PRIVATE_CHAT)).toBe(true);
      expect(await bot.declineChatJoinRequest(GROUP_CHAT, PRIVATE_CHAT)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Chat metadata", () => {
    it("getChat returns chat info", async () => {
      const chat = await bot.getChat(GROUP_CHAT);
      expect(chat.type).toBe("supergroup");
      expect(chat.title).toBe("Parlel Group");
    });

    it("setChatTitle / setChatDescription", async () => {
      expect(await bot.setChatTitle(GROUP_CHAT, "Renamed")).toBe(true);
      expect(await bot.setChatDescription(GROUP_CHAT, "desc")).toBe(true);
      const chat = await bot.getChat(GROUP_CHAT);
      expect(chat.title).toBe("Renamed");
      expect(chat.description).toBe("desc");
    });

    it("deleteChatPhoto works", async () => {
      expect(await bot.deleteChatPhoto(GROUP_CHAT)).toBe(true);
    });

    it("pin / unpin / unpinAll", async () => {
      const msg = await bot.sendMessage(GROUP_CHAT, "pin me");
      expect(await bot.pinChatMessage(GROUP_CHAT, msg.message_id)).toBe(true);
      const chat = await bot.getChat(GROUP_CHAT);
      expect(chat.pinned_message.message_id).toBe(msg.message_id);
      expect(await bot.unpinChatMessage(GROUP_CHAT)).toBe(true);
      expect(await bot.unpinAllChatMessages(GROUP_CHAT)).toBe(true);
    });

    it("getChatAdministrators returns the bot admin", async () => {
      const admins = await bot.getChatAdministrators(GROUP_CHAT);
      expect(admins.length).toBeGreaterThanOrEqual(1);
      expect(admins.some((a: any) => a.user.id === 123456789)).toBe(true);
    });

    it("getChatMemberCount / getChatMembersCount", async () => {
      const count = await bot.getChatMemberCount(GROUP_CHAT);
      expect(count).toBeGreaterThanOrEqual(2);
      const count2 = await bot.getChatMembersCount(GROUP_CHAT);
      expect(count2).toBe(count);
    });

    it("set / delete chat sticker set", async () => {
      expect(await bot.setChatStickerSet(GROUP_CHAT, "packname")).toBe(true);
      expect(await bot.deleteChatStickerSet(GROUP_CHAT)).toBe(true);
    });

    it("leaveChat removes the bot", async () => {
      expect(await bot.leaveChat(GROUP_CHAT)).toBe(true);
      const m = await bot.getChatMember(GROUP_CHAT, 123456789);
      expect(m.status).toBe("left");
    });
  });

  // -------------------------------------------------------------------------
  describe("Callback & inline queries", () => {
    it("answerCallbackQuery records the answer", async () => {
      expect(await bot.answerCallbackQuery("cbq-1", { text: "Done", show_alert: true })).toBe(true);
      const r = await http("GET", "/__parlel/callbacks");
      expect(r.body.count).toBe(1);
      expect(r.body.callbacks[0].text).toBe("Done");
    });

    it("answerInlineQuery works", async () => {
      const results = [{ type: "article", id: "1", title: "Hi", input_message_content: { message_text: "Hi" } }];
      expect(await bot.answerInlineQuery("iq-1", results)).toBe(true);
    });

    it("answerCallbackQuery requires an id", async () => {
      await expect(bot.answerCallbackQuery("")).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("Bot commands & profile", () => {
    it("set / get / delete commands", async () => {
      await bot.setMyCommands([{ command: "start", description: "Start" }, { command: "help", description: "Help" }]);
      const cmds = await bot.getMyCommands();
      expect(cmds.length).toBe(2);
      expect(cmds[0].command).toBe("start");
      await bot.deleteMyCommands();
      const empty = await bot.getMyCommands();
      expect(empty.length).toBe(0);
    });

    it("commands are scoped", async () => {
      await bot.setMyCommands([{ command: "g", description: "group" }], {
        scope: { type: "all_group_chats" },
      });
      const def = await bot.getMyCommands();
      expect(def.length).toBe(0);
      const grp = await bot.getMyCommands({ scope: { type: "all_group_chats" } });
      expect(grp.length).toBe(1);
    });

    it("set / get my description", async () => {
      await bot.setMyDescription({ description: "A test bot" });
      const d = await bot.getMyDescription();
      expect(d.description).toBe("A test bot");
    });

    it("set / get my short description", async () => {
      await bot.setMyShortDescription({ short_description: "short" });
      const d = await bot.getMyShortDescription();
      expect(d.short_description).toBe("short");
    });

    it("set / get my name", async () => {
      await bot.setMyName({ name: "Parlel Renamed" });
      const d = await bot.getMyName();
      expect(d.name).toBe("Parlel Renamed");
    });

    it("set / get chat menu button", async () => {
      await bot.setChatMenuButton({ menu_button: { type: "commands" } });
      const b = await bot.getChatMenuButton();
      expect(b.type).toBe("commands");
    });

    it("set / get default administrator rights", async () => {
      await bot.setMyDefaultAdministratorRights({ rights: { can_manage_chat: true, is_anonymous: false }, for_channels: false });
      const r = await bot.getMyDefaultAdministratorRights();
      expect(r.can_manage_chat).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Editing & deleting messages", () => {
    it("editMessageText updates text + edit_date", async () => {
      const msg = await bot.sendMessage(PRIVATE_CHAT, "before");
      const edited = await bot.editMessageText("after", { chat_id: PRIVATE_CHAT, message_id: msg.message_id });
      expect(edited.text).toBe("after");
      expect(typeof edited.edit_date).toBe("number");
    });

    it("editMessageText with inline_message_id returns true", async () => {
      expect(await bot.editMessageText("x", { inline_message_id: "inline-1" })).toBe(true);
    });

    it("editMessageCaption works", async () => {
      const msg = await bot.sendPhoto(PRIVATE_CHAT, "p.jpg", { caption: "old" });
      const edited = await bot.editMessageCaption("new", { chat_id: PRIVATE_CHAT, message_id: msg.message_id });
      expect(edited.caption).toBe("new");
    });

    it("editMessageReplyMarkup works", async () => {
      const msg = await bot.sendMessage(PRIVATE_CHAT, "kb");
      const markup = { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] };
      const edited = await bot.editMessageReplyMarkup(markup, { chat_id: PRIVATE_CHAT, message_id: msg.message_id });
      expect(edited.reply_markup.inline_keyboard[0][0].text).toBe("Go");
    });

    it("editMessageMedia swaps media", async () => {
      const msg = await bot.sendMessage(PRIVATE_CHAT, "to-become-photo");
      const edited = await bot.editMessageMedia(
        { type: "photo", media: "new.jpg", caption: "swapped" },
        { chat_id: PRIVATE_CHAT, message_id: msg.message_id },
      );
      expect(Array.isArray(edited.photo)).toBe(true);
      expect(edited.caption).toBe("swapped");
    });

    it("deleteMessage removes the message", async () => {
      const msg = await bot.sendMessage(PRIVATE_CHAT, "delete me");
      expect(await bot.deleteMessage(PRIVATE_CHAT, msg.message_id)).toBe(true);
      await expect(bot.deleteMessage(PRIVATE_CHAT, msg.message_id)).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });

    it("editMessageText errors on missing message", async () => {
      await expect(
        bot.editMessageText("x", { chat_id: PRIVATE_CHAT, message_id: 99999 }),
      ).rejects.toMatchObject({ response: { body: { error_code: 400 } } });
    });
  });

  // -------------------------------------------------------------------------
  describe("Stickers", () => {
    it("getStickerSet returns a set", async () => {
      const set = await bot.getStickerSet("AnimalPack");
      expect(set.name).toBe("AnimalPack");
      expect(set.stickers.length).toBeGreaterThanOrEqual(1);
    });

    it("uploadStickerFile returns a file", async () => {
      const f = await bot.uploadStickerFile(PRIVATE_CHAT, { sticker_format: "static" });
      expect(f.file_id).toContain("parlel-sticker");
    });

    it("createNewStickerSet + addStickerToSet + delete", async () => {
      expect(
        await bot.createNewStickerSet({
          user_id: PRIVATE_CHAT,
          name: "parlel_pack_by_bot",
          title: "Parlel Pack",
          stickers: [{ sticker: "f1", emoji_list: ["😀"] }],
        }),
      ).toBe(true);
      const set = await bot.getStickerSet("parlel_pack_by_bot");
      expect(set.stickers.length).toBe(1);
      expect(await bot.addStickerToSet({ user_id: PRIVATE_CHAT, name: "parlel_pack_by_bot", sticker: { sticker: "f2", emoji_list: ["🎉"] } })).toBe(true);
      const set2 = await bot.getStickerSet("parlel_pack_by_bot");
      expect(set2.stickers.length).toBe(2);
      const fileId = set2.stickers[0].file_id;
      expect(await bot.setStickerPositionInSet(fileId, 1)).toBe(true);
      expect(await bot.deleteStickerFromSet(fileId)).toBe(true);
    });
  });

  describe("Reactions", () => {
    it("setMessageReaction records a reaction", async () => {
      const msg = await bot.sendMessage(GROUP_CHAT, "react to me");
      expect(await bot.setMessageReaction(GROUP_CHAT, msg.message_id, [{ type: "emoji", emoji: "👍" }])).toBe(true);
    });

    it("setMessageReaction errors on missing message", async () => {
      await expect(bot.setMessageReaction(GROUP_CHAT, 99999, [])).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });
  });

  describe("Games", () => {
    it("sendGame returns a game message", async () => {
      const msg = await bot.sendGame(GROUP_CHAT, "tetris");
      expect(msg.game.title).toBe("tetris");
    });

    it("setGameScore + getGameHighScores", async () => {
      const msg = await bot.sendGame(GROUP_CHAT, "tetris");
      const updated = await bot.setGameScore(PRIVATE_CHAT, 50, { chat_id: GROUP_CHAT, message_id: msg.message_id });
      expect(updated.message_id).toBe(msg.message_id);
      const scores = await bot.getGameHighScores(PRIVATE_CHAT, { chat_id: GROUP_CHAT, message_id: msg.message_id });
      expect(scores[0].score).toBe(100);
    });
  });

  describe("Sender chat bans", () => {
    it("ban / unban a sender chat", async () => {
      expect(await bot.banChatSenderChat(GROUP_CHAT, -100123)).toBe(true);
      expect(await bot.unbanChatSenderChat(GROUP_CHAT, -100123)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Payments", () => {
    it("sendInvoice returns an invoice message", async () => {
      const msg = await bot.sendInvoice(
        PRIVATE_CHAT,
        "Pro Plan",
        "Monthly subscription",
        "payload-123",
        "provider-token",
        "USD",
        [{ label: "Pro", amount: 999 }],
      );
      expect(msg.invoice.title).toBe("Pro Plan");
      expect(msg.invoice.total_amount).toBe(999);
      expect(msg.invoice.currency).toBe("USD");
    });

    it("answerShippingQuery works", async () => {
      expect(await bot.answerShippingQuery("sq-1", true, { shipping_options: [] })).toBe(true);
    });

    it("answerShippingQuery requires error_message when ok=false", async () => {
      await expect(bot.answerShippingQuery("sq-2", false)).rejects.toMatchObject({
        response: { body: { error_code: 400 } },
      });
    });

    it("answerPreCheckoutQuery works", async () => {
      expect(await bot.answerPreCheckoutQuery("pcq-1", true)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("State inspection & reset", () => {
    it("records sent messages in /__parlel/sent", async () => {
      await bot.sendMessage(PRIVATE_CHAT, "one");
      await bot.sendMessage(PRIVATE_CHAT, "two");
      const r = await http("GET", "/__parlel/sent");
      expect(r.body.count).toBe(2);
    });

    it("lists chats and messages", async () => {
      await bot.sendMessage(PRIVATE_CHAT, "hey");
      const chats = await http("GET", "/__parlel/chats");
      expect(chats.body.count).toBeGreaterThanOrEqual(2);
      const messages = await http("GET", "/__parlel/messages");
      expect(messages.body.count).toBeGreaterThanOrEqual(1);
    });

    it("reset clears everything", async () => {
      await bot.sendMessage(PRIVATE_CHAT, "x");
      await http("POST", "/__parlel/reset");
      const r = await http("GET", "/__parlel/sent");
      expect(r.body.count).toBe(0);
    });
  });
});
