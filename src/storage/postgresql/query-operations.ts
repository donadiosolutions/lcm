import {
  QUERY_GET_CONVERSATION_BY_SESSION_ID,
  QUERY_GET_LAST_MESSAGE,
  QUERY_GET_MAX_SEQ,
  QUERY_GET_MAX_SEQ_FOR_APPEND,
  QUERY_GET_MESSAGE_COUNT,
  QUERY_GET_MESSAGES,
  QUERY_GET_MESSAGES_LIMITED,
  QUERY_LIST_CONVERSATIONS,
  QUERY_LOCK_CONVERSATION_FOR_APPEND,
  QUERY_MARK_CONVERSATION_BOOTSTRAPPED,
} from "./conversation-repository.js";
import { QUERY_GET_PROMOTED_MEMORY_BY_ID } from "./memory-repositories.js";
import {
  QUERY_GET_CONTEXT_ITEMS,
  QUERY_GET_CONTEXT_TOKEN_COUNT,
  QUERY_GET_SUMMARY,
} from "./summary-context-repositories.js";

export interface QueryOperationDefinition {
  readonly id: string;
  readonly templates: readonly string[];
}

export const QUERY_OPERATION_CATALOG: readonly QueryOperationDefinition[] = Object.freeze([
  { id: "conversations.getConversationBySessionId", templates: [QUERY_GET_CONVERSATION_BY_SESSION_ID] },
  { id: "conversations.lockConversationForAppend", templates: [QUERY_LOCK_CONVERSATION_FOR_APPEND] },
  { id: "conversations.getMaxSeqForAppend", templates: [QUERY_GET_MAX_SEQ_FOR_APPEND] },
  { id: "conversations.getMaxSeq", templates: [QUERY_GET_MAX_SEQ] },
  { id: "conversations.getMessages", templates: [QUERY_GET_MESSAGES, QUERY_GET_MESSAGES_LIMITED] },
  { id: "conversations.getLastMessage", templates: [QUERY_GET_LAST_MESSAGE] },
  { id: "conversations.getMessageCount", templates: [QUERY_GET_MESSAGE_COUNT] },
  { id: "conversations.markConversationBootstrapped", templates: [QUERY_MARK_CONVERSATION_BOOTSTRAPPED] },
  { id: "conversations.listConversations", templates: [QUERY_LIST_CONVERSATIONS] },
  { id: "summaries.getSummary", templates: [QUERY_GET_SUMMARY] },
  { id: "context.getContextItems", templates: [QUERY_GET_CONTEXT_ITEMS] },
  { id: "context.getContextTokenCount", templates: [QUERY_GET_CONTEXT_TOKEN_COUNT] },
  { id: "promoted-memory.getById", templates: [QUERY_GET_PROMOTED_MEMORY_BY_ID] },
].map((operation) => Object.freeze({
  ...operation,
  templates: Object.freeze([...operation.templates]),
})));

export const QUERY_OPERATION_IDS: readonly string[] = Object.freeze(
  QUERY_OPERATION_CATALOG.map((operation) => operation.id),
);
