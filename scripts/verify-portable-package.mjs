import { resolve } from "node:path";
import { verifyPortablePackage } from "./portable-package-smoke.mjs";

verifyPortablePackage(resolve(import.meta.dirname, ".."), { checkTypes: false });
