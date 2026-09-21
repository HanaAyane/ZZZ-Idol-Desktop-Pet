import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopPetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopPetRoot, "..");
const read = (file) => readFile(path.join(repositoryRoot, file), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const [workflow, issueForm, packageJson] = await Promise.all([
  read(".github/workflows/windows-build.yml"),
  read(".github/ISSUE_TEMPLATE/windows-bug.yml"),
  read("desktop-pet/package.json"),
]);

assert(workflow.includes("runs-on: windows-2022"), "Windows CI 没有固定 Windows Runner");
assert(workflow.includes("x86_64-pc-windows-msvc"), "Windows CI 没有固定 x64 MSVC 目标");
assert(workflow.includes("npm ci"), "Windows CI 没有锁定安装前端依赖");
assert(workflow.includes("npm run validate:windows-prep"), "Windows CI 没有执行 Windows 准备校验");
assert(packageJson.includes('"validate:windows-prep": "npm run validate:phase7'), "Windows 准备校验没有串联阶段 2～7回归");
assert(workflow.includes("cargo check") && workflow.includes("--locked"), "Windows CI 没有锁定 Rust 检查");
assert(workflow.includes("--bundles nsis,msi"), "Windows CI 没有同时生成 NSIS 与 MSI");
assert(workflow.includes('0.1.${{ github.run_number }}'), "Windows 测试包没有唯一可升级版本");
assert(workflow.includes("SHA256SUMS.txt") && workflow.includes("BUILD-INFO.txt"), "Artifact 缺少校验值或构建身份");
assert(workflow.includes("actions/upload-artifact@v4"), "Windows 安装包没有上传为 Actions Artifact");

for (const field of ["Commit / 测试版本", "Windows 版本与架构", "显示器与缩放", "复现步骤", "预期结果", "实际结果", "发生频率"]) {
  assert(issueForm.includes(field), `Windows Bug 表单缺少：${field}`);
}

console.log("Windows 阶段 8 准备校验通过：x64 NSIS/MSI 构建、唯一测试版本、Artifact 身份校验和 Bug 表单均已就绪。");
