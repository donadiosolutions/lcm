export type SummarizeContext = {
  isCondensed?: boolean;
  targetTokens?: number;
  depth?: number;
  /** Invocation-owned cancellation signal; consumed per summarizer call. */
  signal?: AbortSignal;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  ctx?: SummarizeContext,
) => Promise<string>;
