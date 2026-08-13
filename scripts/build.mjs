import { build, context } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";

const isWatch = process.argv.includes("--watch");
const outdir = "dist";

const entryPoints = {
  sw: "src/sw/index.ts",
  content: "src/content/index.ts",
  popup: "src/popup/index.ts",
  options: "src/options/index.ts",
};

async function copyPublic() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await cp("public", outdir, { recursive: true });
}

async function run() {
  await copyPublic();

  const options = {
    entryPoints,
    bundle: true,
    format: "iife",
    target: "chrome110",
    sourcemap: true,
    outdir,
    minify: !isWatch,
    logLevel: "info",
  };

  if (isWatch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    const result = await build({ ...options, metafile: true });
    const sizes = Object.entries(result.metafile.outputs)
      .filter(([file]) => file.endsWith(".js"))
      .map(([file, info]) => `${file}: ${(info.bytes / 1024).toFixed(1)}KB`)
      .join("\n");
    console.log(sizes);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
