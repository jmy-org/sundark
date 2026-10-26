// The MCP Apps SDKs validate with zod 4, which probes `new Function` when their schemas
// are built at import time; host CSPs report that as a script-src violation. This module
// must be imported before the SDKs. Interpretation is fast enough for these messages.
import { config } from 'zod/v4/core';
config({ jitless: true });
