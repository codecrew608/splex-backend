import { jsonResponse } from "../http.js";

export async function handleHealth(): Promise<Response> {
  return jsonResponse({ status: "ok" });
}
