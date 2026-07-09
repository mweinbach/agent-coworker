import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qualityGateRoot = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(qualityGateRoot, "snapshots/shipping-chat-1240-light-linux.png");
const target = path.resolve(qualityGateRoot, "../../../docs/assets/desktop-product.png");
const checkOnly = process.argv.includes("--check");

const approvedBaseline = await fs.readFile(source);
if (checkOnly) {
  const productScreenshot = await fs.readFile(target);
  if (!approvedBaseline.equals(productScreenshot)) {
    throw new Error(
      "docs/assets/desktop-product.png does not match the approved 1240px light Electron baseline",
    );
  }
  console.log("Product screenshot matches the approved Electron baseline.");
} else {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, approvedBaseline);
  console.log(`Updated ${target} from the approved Electron baseline.`);
}
