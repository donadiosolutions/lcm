---
"@donadiosolutions/lcm": patch
---

Keep default managed daemon start, doctor, and restart calls on one packaged runtime identity, and wait through an exact bounded systemd stop transition before recreating the service.
