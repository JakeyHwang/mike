import { completeText, type UserApiKeys } from "./llm";

/**
 * Title used when the model gives nothing usable: the opening words of the
 * message itself, which is what the sidebar shows for chats that never got a
 * generated title. A fixed placeholder would leave every such chat looking
 * identical.
 */
export function excerptTitle(message: string): string {
    const words = message.replace(/\s+/g, " ").trim().split(" ");
    let title = "";
    for (const word of words) {
        if (title && (title + " " + word).length > 48) break;
        title = title ? title + " " + word : word;
    }
    return title.replace(/[.,:;!?]+$/, "") || "Untitled chat";
}

/**
 * Small reasoning models answer this prompt by restating it; when told about
 * a fallback string they return the fallback. So the prompt asks for a title
 * only, and anything that is not a short title is discarded in favour of an
 * excerpt of the message.
 */
function normalizeGeneratedTitle(raw: string, message: string): string {
    const title = raw
        .trim()
        .split(/\r?\n/)[0]!
        .trim()
        .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
        .trim();
    if (!title || title.length > 80 || title.split(/\s+/).length > 12) {
        return excerptTitle(message);
    }
    return title;
}

export async function generateAssistantChatTitle(args: {
    model: string;
    message: string;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const titleText = await completeText({
        model: args.model,
        user: `Write a title of 3 to 6 words for a conversation on a legal work platform that begins with the message below. Name the topic, matter, or document. Do not use the words "Legal Assistant", "AI", "Chat", "Query" or "Request". Reply with the title only: no quotes, no punctuation, no explanation.\n\nMessage: ${args.message.slice(0, 500)}`,
        maxTokens: 64,
        apiKeys: args.apiKeys,
        // The gateway's chat model reasons before answering; on a 64-token
        // budget that reasoning consumed everything and the title came back
        // empty, which is how every chat ended up as "Misc. Query".
        thinking: false,
    });
    return normalizeGeneratedTitle(titleText, args.message);
}
