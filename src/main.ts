/** Entry point. */

import { App } from "./ui/app";
import { log } from "./core/log";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

log.info("boot", "Living Detective starting");
new App(root);
