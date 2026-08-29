import { isTauri } from "@tauri-apps/api/core";

const desktop = isTauri();
const defaultHttpBaseUrl = desktop ? "http://127.0.0.1:4000/api/v1" : "/api/v1";
const defaultSocketUrl = desktop
  ? "ws://127.0.0.1:4000/client"
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/client`;

const httpBaseUrl = import.meta.env.VITE_QE_HTTP_BASE_URL ?? defaultHttpBaseUrl;
const socketUrl = import.meta.env.VITE_QE_SOCKET_URL ?? defaultSocketUrl;

export const clientConfig = {
  httpBaseUrl: httpBaseUrl.replace(/\/$/, ""),
  socketUrl,
};
