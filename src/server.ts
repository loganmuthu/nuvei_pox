import express from "express";
import { config } from "./config";
import { checkoutRouter } from "./routes/checkout";
import { dmnRouter } from "./routes/dmn";
import { financialOpsRouter } from "./routes/financialOps";
import { hppRouter } from "./routes/hpp";
import { simplyConnectRouter } from "./routes/simplyConnect";
import { sseRouter } from "./routes/sse";
import { testToolsRouter } from "./routes/testTools";

const app = express();

// Required behind Azure App Service's reverse proxy (and any tunnel/host that terminates
// TLS in front of us) — otherwise req.protocol always reports "http", which produces
// insecure notify_url/successUrl values that Nuvei will reject.
app.set("trust proxy", true);

app.use("/webhooks", express.urlencoded({ extended: false }));
app.use(dmnRouter);

app.use(express.json());
app.use("/api", checkoutRouter);
app.use("/api", financialOpsRouter);
app.use("/api", hppRouter);
app.use("/api", simplyConnectRouter);
app.use("/api", sseRouter);
app.use("/api", testToolsRouter);
app.use(express.static("public"));

app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});
