import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function source(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

function animationDuration(value) {
  let maximum = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.time === "number") maximum = Math.max(maximum, node.time);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return maximum;
}

const characterExpectations = {
  airui: {
    actionOverlays: {
      动作_待机: "表情_常态",
      动作_走路: "表情_常态",
      动作_兴奋: "表情_兴奋",
      动作_害羞: "表情_害羞",
      动作_无奈: "表情_无奈",
      动作_生气: "表情_生气",
      动作_自信: "表情_自信",
    },
    reactions: [
      ["动作_兴奋", "表情_兴奋"],
      ["动作_害羞", "表情_害羞"],
      ["动作_自信", "表情_自信"],
      ["动作_无奈", "表情_无奈"],
      ["动作_生气", "表情_生气"],
    ],
    hover: "表情_正视",
    drag: "表情_常态",
  },
  nangong: {
    actionOverlays: {
      动作_待机: "表情_常态",
      动作_走路: "表情_走路",
      动作_害羞: "表情_害羞",
      动作_思考: "表情_思考",
      动作_生气: "表情_生气",
      动作_自信: "表情_自信",
      动作_认真: "表情_认真",
      动作_哭: "表情_假哭",
    },
    reactions: [
      ["动作_思考", "表情_思考"],
      ["动作_害羞", "表情_害羞"],
      ["动作_认真", "表情_认真"],
      ["动作_自信", "表情_自信"],
      ["动作_生气", "表情_生气"],
      ["动作_哭", "表情_假哭"],
    ],
    hover: "表情_正视",
    drag: "表情_常态",
  },
  qianxia: {
    actionOverlays: {
      动作_待机: "表情_常态",
      动作_走路: "表情_常态",
      动作_哈气: "表情_哈气",
      动作_害羞: "表情_害羞",
      动作_心累: "表情_心累",
      动作_思考: "表情_思考",
      动作_生气: "表情_生气",
      动作_自信: "表情_自信",
    },
    reactions: [
      ["动作_害羞", "表情_害羞"],
      ["动作_思考", "表情_思考"],
      ["动作_自信", "表情_自信"],
      ["动作_哈气", "表情_哈气"],
      ["动作_生气", "表情_生气"],
      ["动作_心累", "表情_心累"],
    ],
    hover: "表情_正视",
    drag: "表情_皱眉",
  },
};

let reactionCount = 0;
for (const [id, expectation] of Object.entries(characterExpectations)) {
  const definition = await source(`src/characters/${id}.ts`);
  const skeleton = JSON.parse(await source(`public/characters/${id}/json/${id}.json`));
  const animations = skeleton.animations ?? {};
  assert(definition.includes("behavior:"), `${id} 缺少阶段 4 行为配置`);
  assert(definition.includes(`hoverOverlay: "${expectation.hover}"`), `${id} 悬停表情错误`);
  assert(definition.includes(`dragOverlay: "${expectation.drag}"`), `${id} 拖拽表情错误`);
  const bodyActions = Object.keys(animations).filter((action) => action.startsWith("动作_"));
  assert(
    bodyActions.length === Object.keys(expectation.actionOverlays).length,
    `${id} 动作表情绑定没有覆盖全部身体动作`,
  );
  for (const [action, overlay] of Object.entries(expectation.actionOverlays)) {
    assert(animations[action], `${id} 绑定的身体动作不存在：${action}`);
    assert(animations[overlay], `${id} 绑定的表情不存在：${overlay}`);
    assert(definition.includes(`${action}: "${overlay}"`), `${id} 缺少动作表情绑定：${action} → ${overlay}`);
  }
  for (const [action, overlay] of expectation.reactions) {
    assert(animations[action], `${id} 反馈动作不存在：${action}`);
    assert(animations[overlay], `${id} 反馈表情不存在：${overlay}`);
    assert(animationDuration(animations[action]) > 0, `${id} 反馈动作时长为 0：${action}`);
    assert(
      definition.includes(`action: "${action}", overlay: "${overlay}"`),
      `${id} 行为配置缺少 ${action} + ${overlay}`,
    );
    reactionCount += 1;
  }
}

const [loader, mixer, dragSway, renderer, stateMachine, interaction, petApp, styles, tauriLib, defaultCapability, petCapability] =
  await Promise.all([
    source("src/renderer/SpineAssetLoader.ts"),
    source("src/renderer/AnimationMixer.ts"),
    source("src/renderer/DragSwayController.ts"),
    source("src/renderer/SpineRenderer.ts"),
    source("src/pet/PetStateMachine.ts"),
    source("src/pet/PetInteractionController.ts"),
    source("src/pet/PetApp.ts"),
    source("src/styles.css"),
    source("src-tauri/src/lib.rs"),
    source("src-tauri/capabilities/default.json"),
    source("src-tauri/capabilities/pet-interaction.json"),
  ]);

assert(loader.includes('premultiplyAlpha: "none"'), "纹理加载未禁用 ImageBitmap 预乘 Alpha");
assert(renderer.includes("premultipliedAlpha: true"), "透明 WebGL 桌面合成约定被改坏");
assert(mixer.includes("playbackId"), "动画完成事件缺少播放请求编号");
assert(mixer.includes("animation.duration > 0"), "零时长身体动作仍可能循环");
assert(mixer.includes("overlayDuration > 0"), "零时长表情仍可能循环");
assert(mixer.includes("clearTrack(1)"), "表情切换没有独立替换 Track 1");
assert(mixer.includes("bodyTrackTime"), "表情切换没有保留身体轨道时间");
assert(dragSway.includes("pivot.rotation.z"), "拖拽摆动没有旋转完整角色容器");
assert(dragSway.includes("one hanging doll"), "拖拽摆动没有明确采用整体悬挂模型");
assert(dragSway.includes("motionDeadZoneCssPx"), "整体悬挂摆动缺少小位移死区");
assert(dragSway.includes("smoothingAlpha"), "整体悬挂摆动缺少速度平滑");
assert(dragSway.includes("velocityChange"), "整体悬挂摆动没有把加速度转为惯性角速度");
assert(!dragSway.includes("directAnglePerPixel"), "整体悬挂摆动仍在直接把单次位移写入倾角");
assert(dragSway.includes("springStrength"), "拖拽摆动缺少弹簧回正");
assert(dragSway.includes("resetTransform"), "拖拽摆动回正后没有复位整体变换");
assert(renderer.includes("dragSway?.update(delta)"), "渲染循环未更新拖拽摆动");
assert(renderer.includes("head-top-drag-pivot"), "角色没有挂到固定头顶悬点容器");
assert(renderer.includes("stableFitBounds = this.measureCurrentBounds()"), "角色加载时没有锁定待机基准边界");
assert(renderer.includes("this.stableFitBounds ?? this.measureCurrentBounds()"), "动作切换仍可能按当前帧边界改变整体尺寸");
assert(stateMachine.includes("playbackId !== this.currentOneShot.playbackId"), "旧完成事件可能抢占状态");
assert(stateMachine.includes("this.host.play(reaction.action, false"), "点击反馈动作没有按一次性播放");
assert(stateMachine.includes("restOverlay"), "状态机没有保存并恢复用户选择的基础表情");
assert(stateMachine.includes("setRestPose(action: string, overlay: string)"), "状态机未统一保存动作和绑定表情");
assert(stateMachine.includes('commit("dragging"'), "状态机缺少 dragging 状态");
assert(stateMachine.includes('commit("dropped"'), "状态机缺少 dropped 状态");

const pointerDownBlock = interaction.slice(
  interaction.indexOf("private readonly handlePointerDown"),
  interaction.indexOf("private readonly handleGlobalPointerDownFallback"),
);
assert(pointerDownBlock.includes("this.startCursorDrag(") && pointerDownBlock.includes("this.nativeWindow.startDragging()"), "光标拖拽或其他平台的原生拖拽没有在 pointerdown 立即启动");
assert(tauriLib.includes("fn sample_pet_cursor"), "原生层缺少全局光标与窗口坐标采样命令");
assert(tauriLib.includes(".cursor_position()"), "逐像素穿透没有持续读取全局光标");
assert(tauriLib.includes("window.inner_position()"), "逐像素穿透没有读取内容区原点");
assert(tauriLib.includes("fn set_pet_cursor_passthrough"), "原生层缺少逐像素整窗穿透命令");
assert(tauriLib.includes("set_ignore_cursor_events(enabled)"), "惯性期间没有启用整窗鼠标穿透");
assert(interaction.includes("onMoved"), "拖拽没有根据真实窗口位移确认");
assert(interaction.includes("onDragMove"), "窗口或指针位移没有传给拖拽摆动");
assert(interaction.includes("PIXEL_HIT_TEST_INTERVAL_MS = 40"), "逐像素命中没有限制为 25Hz");
assert(interaction.includes('invoke<PetCursorSample>("sample_pet_cursor")'), "交互层未轮询原生光标采样");
assert(interaction.includes("PIXEL_ENTER_ALPHA"), "逐像素命中缺少进入 Alpha 阈值");
assert(interaction.includes("PIXEL_EXIT_ALPHA"), "逐像素命中缺少离开 Alpha 阈值");
assert(interaction.includes("PIXEL_EXIT_CONFIRMATIONS"), "逐像素命中缺少连续透明样本确认");
assert(interaction.includes("document.elementFromPoint"), "逐像素命中未保护调试面板等 DOM 控件");
assert(interaction.includes("passthroughTransition"), "逐像素穿透切换没有串行化");
assert(interaction.includes("!this.pointerDown && !this.dragging"), "拖拽期间没有锁定窗口为可交互");
assert(renderer.includes("sampleAlphaAt(clientX: number, clientY: number)"), "渲染器缺少逐像素 Alpha 探针");
assert(renderer.includes("WebGLRenderTarget"), "逐像素命中未使用离屏 GPU 探针");
assert(renderer.includes("readRenderTargetPixels"), "逐像素命中未读取当前渲染 Alpha");
assert(renderer.includes("HIT_TEST_PROBE_SIZE = 3"), "逐像素命中缺少抗锯齿边缘小邻域");
assert(renderer.includes("diagnosePixelHitTest()"), "逐像素命中缺少透明点与角色点探针自检");
assert(interaction.includes("if (!this.nativeWindow) this.emitPointerMotion(event)"), "原生窗口位移与 DOM 指针位移可能重复累计");
assert(interaction.includes("DRAG_THRESHOLD_CSS_PX"), "拖拽缺少 DPI 感知阈值");
assert(interaction.includes("NATIVE_DRAG_STABLE_MS"), "系统拖拽回退路径缺少防卡死兜底");
assert(interaction.includes("RAPID_CLICK_THRESHOLD = 5"), "连续点击阈值不是 5 次");
assert(interaction.includes("DOUBLE_CLICK_MS = 300"), "双击判定窗口不是 300ms");
assert(interaction.includes("HOVER_INTENT_MS = 300"), "悬停缺少停留意图判定");
assert(interaction.includes("hoverIntentTimer"), "悬停意图计时器未接入或无法清理");
assert(interaction.includes('surface.addEventListener("contextmenu", this.handleContextMenu)'), "人物右键菜单事件未接入");
assert(interaction.includes('invoke<void>("show_pet_context_menu")'), "人物右键没有调用原生共享菜单");
assert(tauriLib.includes("struct PetContextMenu(Menu<tauri::Wry>)"), "人物右键没有复用托盘原生菜单");
assert(tauriLib.includes(".popup_menu(&menu.0)"), "人物右键菜单没有在桌宠窗口弹出");
assert(!interaction.includes("data-tauri-drag-region"), "交互控制器错误使用 Tauri drag region");

assert(petApp.includes("new PetStateMachine"), "PetApp 未接入状态机");
assert(petApp.includes("new PetInteractionController"), "PetApp 未接入交互控制器");
assert(!petApp.includes('class="pet-status"'), "人物底部状态指示仍存在");
assert(!styles.includes(".pet-status"), "人物底部状态指示样式仍存在");
assert(petApp.includes("this.renderer.sampleAlphaAt(clientX, clientY)"), "PetApp 未连接 WebGL Alpha 与交互穿透");
assert(petApp.includes("onPixelPassthroughSample"), "PetApp 未暴露逐像素穿透运行诊断");
assert(petApp.includes("renderer.startDragSway()"), "拖拽开始未启动下半身摆动");
assert(petApp.includes("renderer.pushDragMotion"), "拖拽位移未驱动下半身摆动");
assert(petApp.includes("renderer.endDragSway()"), "拖拽结束未触发惯性回正");
assert(petApp.includes("dragSwayRespondsToMotion"), "交互自检未覆盖拖拽摆动响应");
assert(petApp.includes("tinyMotionDoesNotTwitch"), "交互自检未覆盖小范围移动防抽搐");
assert(petApp.includes("dragSwayInertiaEvolves"), "交互自检未覆盖释放后的惯性角度变化");
assert(petApp.includes("dragSwaySettlesAfterRelease"), "交互自检未覆盖拖拽摆动回正");
assert(petApp.includes("overlayForAction(action)"), "手动选择动作时没有解析绑定表情");
assert(petApp.includes("doubleSuppressesSingle"), "缺少双击抑制单击自检");
assert(petApp.includes("quickHoverPreservesRestOverlay"), "缺少快速经过不替代表情的回归自检");
assert(petApp.includes("manualExpressionSurvivesDwellHover"), "缺少手动表情不被长悬停替代的回归自检");
assert(petApp.includes("defaultDwellUsesHoverOverlay"), "缺少默认表情悬停反馈的回归自检");
assert(petApp.includes("hoverLeaveRestoresRestOverlay"), "缺少悬停离开恢复基础表情的回归自检");
assert(petApp.includes("entry.id > transitionBeforeDouble"), "交互自检在历史上限后可能误报双击失败");
assert(petApp.includes("getSlotFingerprint"), "缺少表情槽位残留自检");
assert(petApp.includes('overlay !== "表情_0" && !overlay.endsWith("_in")'), "调试面板仍暴露过渡表情");
assert(petApp.includes('action !== "0"'), "调试面板仍暴露零时长身体动作 0");
assert(styles.includes('[data-pet-state="dragging"]'), "缺少拖拽视觉状态");
assert(!styles.includes('[data-pet-state="dropped"] .spine-canvas'), "落下状态仍在叠加旧 CSS 画布动画");

const defaultPermissions = JSON.parse(defaultCapability);
const petPermissions = JSON.parse(petCapability);
assert(defaultPermissions.windows.includes("settings"), "默认 capability 不再覆盖设置窗口");
assert(
  ["pet-airui", "pet-nangong", "pet-qianxia"].every((label) => petPermissions.windows.includes(label)),
  "拖拽权限未覆盖三个桌宠窗口",
);
for (const permission of [
  "core:window:allow-start-dragging",
  "core:window:allow-outer-position",
  "core:window:allow-scale-factor",
]) {
  assert(petPermissions.permissions.includes(permission), `拖拽 capability 缺少 ${permission}`);
}

const tauriConfig = JSON.parse(await source("src-tauri/tauri.conf.json"));
const petWindows = tauriConfig.app.windows.filter((window) => window.label.startsWith("pet-"));
assert(petWindows.length === 3, "没有配置三个桌宠窗口");
for (const petWindow of petWindows) {
  assert(petWindow.width === 520 && petWindow.height === 600, `${petWindow.label} 没有固定为摆动安全边界`);
  assert(petWindow.minWidth === 520 && petWindow.minHeight === 600, `${petWindow.label} 最小尺寸错误`);
  assert(petWindow.maxWidth === 520 && petWindow.maxHeight === 600, `${petWindow.label} 最大尺寸错误`);
}
assert(renderer.includes("PET_VISUAL_WIDTH = 360"), "扩大窗口后角色视觉宽度没有保持 360 基准");
assert(renderer.includes("PET_VISUAL_HEIGHT = 480"), "扩大窗口后角色视觉高度没有保持 480 基准");
assert(!styles.includes('data-pet-state="dragging"] .spine-canvas'), "旧 CSS 拖拽倾斜仍与物理摆动叠加");
assert(!styles.includes("pet-drop-bounce"), "旧 CSS 落下缩放仍与物理摆动叠加");

console.log(
  `阶段 4 静态校验通过：3/3 角色、${reactionCount} 组反馈映射、播放令牌、表情 Alpha、点击判定、头顶悬点整体摆动与主窗口权限均已接入。`,
);
