export type SummarizeContext = {
  isCondensed?: boolean;
  targetTokens?: number;
  depth?: number;
  /** Invocation-owned cancellation signal; consumed per summarizer call. */
  signal?: AbortSignal;
  /** Invocation identity used to scope provider process witnesses. */
  invocationId?: string;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  ctx?: SummarizeContext,
) => Promise<string>;
