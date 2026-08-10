// Keep the transport implementation model-agnostic while making the product
// default explicit. Operators can still override OPENAI_REALTIME_MODEL.
process.env.OPENAI_REALTIME_MODEL ||= "gpt-realtime-2.1";

await import("./openai-realtime-direct-relay");
