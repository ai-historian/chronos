import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("chronos", { version: process.versions.electron });
