---
"@donadiosolutions/lcm": patch
---

Verify the local daemon process and loopback listener before sending credentials or private data from read and store commands, pre-tool recall, MCP tools, installation, doctor, legacy migration and publication retries. Refuse these requests when ownership cannot be established, including on Windows where recipient admission is currently unsupported.
