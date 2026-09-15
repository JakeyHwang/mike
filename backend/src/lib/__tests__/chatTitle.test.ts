import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeText } = vi.hoisted(() => ({
    completeText: vi.fn(),
}));

vi.mock("../llm", () => ({ completeText }));

import { excerptTitle, generateAssistantChatTitle } from "../chatTitle";

describe("generateAssistantChatTitle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("normalizes and returns the generated title, with reasoning switched off", async () => {
        completeText.mockResolvedValue('  "German Liquidity Review."  ');

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Review the company liquidity position",
                apiKeys: {},
            }),
        ).resolves.toBe("German Liquidity Review");
        expect(completeText).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "title-model",
                maxTokens: 64,
                apiKeys: {},
                thinking: false,
            }),
        );
    });

    it("falls back to the opening words of the message when the model returns nothing", async () => {
        completeText.mockResolvedValue("   ");

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message:
                    "Can you review this tenancy agreement and tell me whether the landlord can terminate early?",
            }),
        ).resolves.toBe("Can you review this tenancy agreement and tell");
    });

    it("discards a model answer that is prose rather than a title", async () => {
        completeText.mockResolvedValue(
            "We need to generate a concise title (3-6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe",
        );

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Limitation period for breach of contract in Singapore?",
            }),
        ).resolves.toBe("Limitation period for breach of contract in");
    });

    it("keeps only the first line of a multi-line answer", async () => {
        completeText.mockResolvedValue("Demand Letter for Overdue Invoice\n\nThis title captures the topic.");

        await expect(
            generateAssistantChatTitle({ model: "m", message: "draft a letter of demand" }),
        ).resolves.toBe("Demand Letter for Overdue Invoice");
    });
});

describe("excerptTitle", () => {
    it("cuts at a word boundary under 48 characters and drops trailing punctuation", () => {
        expect(excerptTitle("What is the limitation period for a breach of contract claim in Singapore?")).toBe(
            "What is the limitation period for a breach of",
        );
        expect(excerptTitle("   ")).toBe("Untitled chat");
    });
});
