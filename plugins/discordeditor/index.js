import settings from "./settings.jsx";
import * as common from "../../common";
import { FluxDispatcher, moment } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { before as patchBefore } from "@vendetta/patcher";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { Messages } from "@vendetta/metro/common";

common.makeDefaults(storage, {
	ignore: {
		users: [],
		channels: [],
		bots: false,
	},
	timestamps: false,
	ew: false,
	onlyTimestamps: false,
	dCommand: true, // NEW: d command toggle
	logEdits: true, // NEW: log edits toggle
});

let MessageStore,
	ChannelStore,
	deleteable = [];

// Track recently sent messages so we can find "the message before the d"
let lastSentMessage = null; 
let pendingSelfDeletes = new Set(); // message ids we're deleting ourselves

const patches = [];

// Helper: send a message via FluxDispatcher
function deleteMessage(channelId, messageId) {
	pendingSelfDeletes.add(messageId);
	Messages.deleteMessage(channelId, messageId).catch((e) => {
		console.error("[NoDelete] delete failed", e);
		pendingSelfDeletes.delete(messageId);
	});
}

// Helper: send an automod-style "edited" notice
function pushLocalNotice(channelId, messageId, text) {
	FluxDispatcher.dispatch({
		type: "MESSAGE_EDIT_FAILED_AUTOMOD",
		messageData: {
			type: 1,
			message: { channelId, messageId },
		},
		errorResponseBody: {
			code: 200000,
			message: text,
		},
	});
}

export default {
	settings,
	onUnload() {
		for (const unpatch of patches) unpatch();
		patches.length = 0;
	},
	onLoad() {
		try {
			// ------------------------------------------------------------------
			// PATCH 1: intercept MESSAGE_DELETE (original behaviour)
			// ------------------------------------------------------------------
			patches.push(
				patchBefore("dispatch", FluxDispatcher, (args) => {
					try {
						if (!MessageStore) MessageStore = findByStoreName("MessageStore");
						const event = args[0];

						// Track sends/deletes for the "d" command
						if (event?.type === "MESSAGE_CREATE") {
							const me = findByStoreName("UserStore").getCurrentUser();
							if (event.message?.author?.id === me?.id) {
								lastSentMessage = {
									channelId: event.message.channelId,
									messageId: event.message.id,
									content: event.message.content,
								};
							}
						}

						// If this is a delete *we* triggered, let it through
						if (event?.type === "MESSAGE_DELETE" && pendingSelfDeletes.has(event.id)) {
							pendingSelfDeletes.delete(event.id);
							return args;
						}

						if (!event || event?.type !== "MESSAGE_DELETE") return;
						if (!event?.id || !event?.channelId) return;

						const message = MessageStore.getMessage(event.channelId, event.id);

						if (storage["ignore"]["users"].includes(message?.author?.id)) return;
						if (storage["ignore"]["bots"] && message?.author?.bot) return;

						if (deleteable.includes(event.id)) {
							deleteable.splice(deleteable.indexOf(event.id), 1);
							return args;
						}
						deleteable.push(event.id);

						let automodMessage = "This message was deleted";
						if (storage["timestamps"])
							automodMessage += ` (${moment().format(
								storage["ew"] ? "hh:mm:ss.SS a" : "HH:mm:ss.SS"
							)})`;

						args[0] = {
							type: "MESSAGE_EDIT_FAILED_AUTOMOD",
							messageData: {
								type: 1,
								message: {
									channelId: event.channelId,
									messageId: event.id,
								},
							},
							errorResponseBody: {
								code: 200000,
								message: automodMessage,
							},
						};
						return args;
					} catch (e) {
						console.error(e);
						alert(`[Nodelete → dispatcher patch] died\n${e.stack}`);
					}
				})
			);

			// ------------------------------------------------------------------
			// PATCH 2: intercept MESSAGE_CREATE to implement the "d" command
			// ------------------------------------------------------------------
			patches.push(
				patchBefore("dispatch", FluxDispatcher, (args) => {
					try {
						if (!storage.dCommand) return args;
						const event = args[0];
						if (event?.type !== "MESSAGE_CREATE") return;
						if (!event.message) return;

						const me = findByStoreName("UserStore").getCurrentUser();
						if (event.message.author?.id !== me?.id) return;
						if (event.message.content !== "d") return;

						if (!MessageStore) MessageStore = findByStoreName("MessageStore");
						const messages = MessageStore.getMessages(event.message.channelId);
						const all = messages?._array ?? [];
						
						// Find the most recent self message before the "d"
						const recent = all.filter(
							(m) =>
								m.id !== event.message.id &&
								m.author?.id === me.id &&
								m.state !== "SEND_FAILED"
						);
						const target = recent[recent.length - 1]; 

						// Queue both deletes on the next tick
						setTimeout(() => {
							try {
								if (target) deleteMessage(event.message.channelId, target.id);
								deleteMessage(event.message.channelId, event.message.id);
							} catch (e) {
								console.error("[NoDelete] d-command delete failed", e);
							}
						}, 250);
					} catch (e) {
						console.error(e);
						alert(`[Nodelete → d-command patch] died\n${e.stack}`);
					}
					return args;
				})
			);

			// ------------------------------------------------------------------
			// PATCH 3: intercept MESSAGE_UPDATE for edited-message logging
			// ------------------------------------------------------------------
			patches.push(
				patchBefore("dispatch", FluxDispatcher, (args) => {
					try {
						if (!storage.logEdits) return args;
						const event = args[0];
						if (event?.type !== "MESSAGE_UPDATE") return;
						if (!event.message?.id || !event.message?.channelId) return;
						// Ignore embed-only updates
						if (event.message.content === undefined) return;

						if (!MessageStore) MessageStore = findByStoreName("MessageStore");
						const old = MessageStore.getMessage(
							event.message.channelId,
							event.message.id
						);
						if (!old) return;
						// Only log real content changes
						if (old.content === event.message.content) return;

						const me = findByStoreName("UserStore").getCurrentUser();
						const author = old.author?.id === me?.id ? "You" : old.author?.username ?? "Unknown";

						const ts = storage["timestamps"]
							? ` (${moment().format(storage["ew"] ? "hh:mm:ss.SS a" : "HH:mm:ss.SS")})`
							: "";

						const logText =
							`**Edited message**${ts} — ${author}\n` +
							`**Before:** ${old.content || "*(empty)*"}\n` +
							`**After:** ${event.message.content || "*(empty)*"}`;

						// Post it as a local system-ish message in the same channel
						pushLocalNotice(
							event.message.channelId,
							event.message.id,
							logText
						);
					} catch (e) {
						console.error(e);
						alert(`[Nodelete → edit-log patch] died\n${e.stack}`);
					}
					return args;
				})
			);
		} catch (e) {
			console.error(e);
			alert(`[NoDelete] dead\n${e.stack}`);
		}
	},
};
