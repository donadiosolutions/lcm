function invalidCanonicalQuery(): never {
  // Canonical query text can contain private prompt data. Never attach it.
  throw new Error("Invalid canonical tsquery evidence");
}

/**
 * Parse PostgreSQL-generated tsquery text, never raw websearch input.
 *
 * Binary precedence affects selection, but not leaf polarity: only NOT and
 * its parenthesized scope can flip that polarity. An operand-state machine
 * and a stack of enclosing polarities therefore validate the whole grammar
 * without recursion, an AST, or a second complete token array.
 */
export function parseTsqueryEvidence(canonical: string): {
  atoms: string[];
  groupIds: number[];
  queryTermCount: number;
} {
  const atoms: string[] = [];
  const groupIds: number[] = [];
  const groups = new Map<string, number>();
  const variants = new Set<string>();
  const enclosingPolarities: boolean[] = [];
  const phraseOperator = /<(?:-|0|[1-9][0-9]*)>/y;
  let positive = true;
  let negate = false;
  let expectOperand = true;
  let sawToken = false;
  let position = 0;

  while (position < canonical.length) {
    const character = canonical[position];
    if (/\s/u.test(character)) {
      position++;
      continue;
    }
    sawToken = true;

    if (expectOperand) {
      if (character === "!") {
        negate = !negate;
        position++;
        continue;
      }
      if (character === "(") {
        enclosingPolarities.push(positive);
        positive = positive !== negate;
        negate = false;
        position++;
        continue;
      }
      if (character !== "'") invalidCanonicalQuery();

      const atomStart = position++;
      let lexeme = "";
      let closed = false;
      while (position < canonical.length) {
        const part = canonical[position++];
        if (part === "'") {
          if (canonical[position] === "'") {
            lexeme += "'";
            position++;
          } else {
            closed = true;
            break;
          }
        } else if (part === "\\") {
          if (canonical[position] !== "\\") invalidCanonicalQuery();
          lexeme += "\\";
          position++;
        } else {
          if (part === "\u0000") invalidCanonicalQuery();
          lexeme += part;
        }
      }
      if (!closed || lexeme.length === 0) invalidCanonicalQuery();

      if (canonical[position] === ":") {
        const qualifierStart = ++position;
        if (canonical[position] === "*") position++;
        let previousWeight = "";
        while (position < canonical.length && /[A-D]/u.test(canonical[position])) {
          if (canonical[position] <= previousWeight) invalidCanonicalQuery();
          previousWeight = canonical[position];
          position++;
        }
        if (position === qualifierStart) invalidCanonicalQuery();
      }

      if (positive !== negate) {
        const atom = canonical.slice(atomStart, position);
        if (!variants.has(atom)) {
          variants.add(atom);
          let groupId = groups.get(lexeme);
          if (groupId === undefined) {
            groupId = groups.size;
            groups.set(lexeme, groupId);
          }
          atoms.push(atom);
          groupIds.push(groupId);
        }
      }
      negate = false;
      expectOperand = false;
      continue;
    }

    if (character === ")") {
      const enclosing = enclosingPolarities.pop();
      if (enclosing === undefined) invalidCanonicalQuery();
      positive = enclosing;
      position++;
    } else if (character === "&" || character === "|") {
      expectOperand = true;
      position++;
    } else if (character === "<") {
      phraseOperator.lastIndex = position;
      const phrase = phraseOperator.exec(canonical);
      if (phrase === null) invalidCanonicalQuery();
      position = phraseOperator.lastIndex;
      expectOperand = true;
    } else {
      invalidCanonicalQuery();
    }
  }

  if (enclosingPolarities.length > 0 || (sawToken && expectOperand)) {
    invalidCanonicalQuery();
  }
  return { atoms, groupIds, queryTermCount: groups.size };
}
