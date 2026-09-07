---
"@donadiosolutions/lcm": patch
---

Redact file URL authority and path tails glued to an already active unquoted
absolute path, including userinfo, ports, and bracketed hosts. This keeps
public error responses stable after one sanitization pass without changing
standalone URL classification.
