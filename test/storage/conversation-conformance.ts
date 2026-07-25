import { expect } from "vitest";
import type { ConversationRepository } from "../../src/storage/contracts.js";
import type {
  ConversationRecord,
  MessageRecord,
} from "../../src/store/conversation-store.js";

export interface ConversationRepositoryConformanceFixtures {
  readonly first: ConversationRecord;
  readonly second: ConversationRecord;
  readonly messages: readonly [MessageRecord, MessageRecord];
  readonly third: MessageRecord;
  readonly appended: readonly [MessageRecord, MessageRecord];
}

/**
 * Backend-neutral conversation-domain contract. It intentionally depends only
 * on ConversationRepository so staged adapters can prove parity without
 * pretending to support the remaining ProjectStorage domains.
 */
export async function exerciseConversationRepositoryConformance(
  repository: ConversationRepository,
): Promise<ConversationRepositoryConformanceFixtures> {
  const first = await repository.createConversation({ sessionId: "session-a", title: "A" });
  const second = await repository.createConversation({ sessionId: "session-b" });
  expect((await repository.listConversations()).map((row) => row.conversationId)).toEqual([
    first.conversationId,
    second.conversationId,
  ]);
  expect(await repository.getConversation(first.conversationId)).toMatchObject({ title: "A" });
  expect(await repository.getConversation(999_999)).toBeNull();
  expect(await repository.getConversationBySessionId("session-a"))
    .toMatchObject({ sessionId: "session-a" });
  expect(await repository.getConversationBySessionId("missing")).toBeNull();
  expect((await repository.getOrCreateConversation("session-a")).conversationId)
    .toBe(first.conversationId);
  expect((await repository.getOrCreateConversation("session-c", "C")).title).toBe("C");

  await repository.markConversationBootstrapped(first.conversationId);
  const firstBootstrap = (await repository.getConversation(first.conversationId))?.bootstrappedAt;
  expect(firstBootstrap).toBeInstanceOf(Date);
  await repository.markConversationBootstrapped(first.conversationId);
  expect((await repository.getConversation(first.conversationId))?.bootstrappedAt?.getTime())
    .toBe(firstBootstrap?.getTime());

  const createdMessages = await repository.createMessagesBulk([
    {
      conversationId: first.conversationId,
      seq: 0,
      role: "user",
      content: "alpha needle",
      tokenCount: 2,
    },
    {
      conversationId: first.conversationId,
      seq: 1,
      role: "assistant",
      content: "beta needle",
      tokenCount: 3,
    },
  ]);
  expect(createdMessages).toHaveLength(2);
  const messages = createdMessages as [MessageRecord, MessageRecord];
  const third = await repository.createMessage({
    conversationId: first.conversationId,
    seq: 2,
    role: "tool",
    content: "gamma",
    tokenCount: 4,
  });
  const createdAppended = await repository.appendMessages(first.conversationId, [
    { role: "user", content: "delta", tokenCount: 5 },
    { role: "assistant", content: "epsilon", tokenCount: 6 },
  ]);
  expect(createdAppended).toHaveLength(2);
  const appended = createdAppended as [MessageRecord, MessageRecord];
  expect(appended.map((row) => row.seq)).toEqual([3, 4]);
  expect(await repository.appendMessages(first.conversationId, [])).toEqual([]);
  expect(await repository.createMessagesBulk([])).toEqual([]);
  expect((await repository.getMessages(first.conversationId)).map((row) => row.seq))
    .toEqual([0, 1, 2, 3, 4]);
  expect((await repository.getMessages(
    first.conversationId,
    { afterSeq: 0, limit: 1 },
  ))[0]?.seq).toBe(1);
  expect((await repository.getLastMessage(first.conversationId))?.messageId)
    .toBe(appended[1].messageId);
  expect(await repository.getLastMessage(second.conversationId)).toBeNull();
  expect(await repository.hasMessage(first.conversationId, "user", "alpha needle")).toBe(true);
  expect(await repository.hasMessage(first.conversationId, "user", "missing")).toBe(false);
  expect(await repository.countMessagesByIdentity(
    first.conversationId,
    "user",
    "alpha needle",
  )).toBe(1);
  expect((await repository.getMessageById(messages[0].messageId))?.seq).toBe(0);
  expect(await repository.getMessageById(999_999)).toBeNull();

  const opaquePartMetadata = "  { \"not\": valid-json }\nscalar  ";
  await repository.createMessageParts(messages[0].messageId, [{
    sessionId: "session-a",
    partType: "tool",
    ordinal: 1,
    toolCallId: "call-a",
    toolName: "shell",
    toolInput: "{}",
    toolOutput: "done",
    metadata: opaquePartMetadata,
  }, {
    sessionId: "session-a",
    partType: "text",
    ordinal: 0,
    textContent: "alpha",
  }]);
  await repository.createMessageParts(messages[0].messageId, []);
  expect(await repository.getMessageParts(messages[0].messageId)).toMatchObject([{
    ordinal: 0,
    partType: "text",
    textContent: "alpha",
  }, {
    ordinal: 1,
    partType: "tool",
    toolName: "shell",
    metadata: opaquePartMetadata,
  }]);

  expect(await repository.getMessageCount(first.conversationId)).toBe(5);
  expect(await repository.getMessageCount(second.conversationId)).toBe(0);
  const split = await repository.createConversation({ sessionId: "session-a", title: "split" });
  await repository.createMessage({
    conversationId: split.conversationId,
    seq: 0,
    role: "user",
    content: "split message",
    tokenCount: 2,
  });
  expect(await repository.getMessageCountBySessionId("session-a")).toBe(6);
  expect(await repository.getMessageCountBySessionId("missing")).toBe(0);
  expect(await repository.getMaxSeq(first.conversationId)).toBe(4);
  expect(await repository.getMaxSeq(second.conversationId)).toBe(0);

  return { first, second, messages, third, appended };
}
