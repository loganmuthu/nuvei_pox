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
