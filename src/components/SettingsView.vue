<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import type { PaletteId } from "../types";
import { useDataStore } from "../stores/data";
import { useSettingsStore } from "../stores/settings";
import { useThemeStore } from "../stores/theme";
import { useUiStore } from "../stores/ui";
import { I } from "./icons";
import DropdownSelect from "./DropdownSelect.vue";

const settings = useSettingsStore();
const data = useDataStore();
const ui = useUiStore();
const theme = useThemeStore();

function setTheme(v: "auto" | "light" | "dark") {
  settings.set("theme", v);
  theme.apply();
}

const PALETTES: { id: PaletteId; label: string }[] = [
  { id: "warm", label: "暖米白" },
  { id: "sepia", label: "羊皮纸" },
  { id: "sage", label: "护眼绿" },
  { id: "indigo", label: "靛蓝" },
];

function setPalette(v: PaletteId) {
  settings.set("palette", v);
  theme.apply();
}

function askClear() {
  ui.modal = {
    type: "confirm",
    title: "清空所有数据？",
    body: `将删除 ${data.items.length} 篇文章与 ${data.feeds.length} 个订阅源，此操作不可恢复。`,
    danger: true,
    onOk: () => data.clearAllData(),
  };
}

function exportOpml() {
  const path = utools.showSaveDialog({
    title: "导出 OPML",
    defaultPath: "airss-subscriptions.opml",
    filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
  });
  if (path) data.exportOpml(path);
}

// ---- AI（二期）：引擎配置在 preload（airss.ai），密钥只进 dbCryptoStorage ----
type AiStatus = Awaited<ReturnType<typeof window.airss.ai.getStatus>>;
const aiStatus = ref<AiStatus | null>(null);
const aiCfg = reactive({ ...window.airss.ai.getConfig() });
const byokKeyInput = ref("");
const byokKeySaved = ref(window.airss.ai.hasByokKey());

onMounted(async () => {
  refreshLogCount();
  try {
    aiStatus.value = await window.airss.ai.getStatus();
  } catch {
    aiStatus.value = null;
  }
});

function saveAiCfg(patch: Record<string, unknown>) {
  Object.assign(aiCfg, window.airss.ai.saveConfig(patch));
  aiStatus.value = null; // 引擎/模型可能变化，重新探测
  window.airss.ai
    .getStatus()
    .then((s) => (aiStatus.value = s))
    .catch(() => {});
}

function saveByokKey() {
  const k = byokKeyInput.value.trim();
  window.airss.ai.setByokKey(k);
  byokKeySaved.value = !!k;
  byokKeyInput.value = "";
  ui.toast(k ? "密钥已加密保存" : "已清除密钥");
  saveAiCfg({});
}

/** 模型下拉：同时存内部 id（调 utools.ai 用）与可读名（日志显示用） */
function onModelPick(v: string | number) {
  const id = String(v);
  const label = (aiStatus.value?.models || []).find((m) => m.id === id)?.label || "";
  saveAiCfg({ model: id, modelLabel: label });
}

/** AI 总开关：渲染层设置与 preload 侧硬门控同步翻转（默认关） */
function setAiEnabled(v: boolean) {
  settings.set("aiEnabled", v);
  saveAiCfg({ enabled: v });
}

// ---- 关键词过滤（PLAN-V1.3 B）：每行一个词，blur 时解析入库（多词 OR）----
const muteWordsText = ref(settings.muteWords.join("\n"));
const highlightWordsText = ref(settings.highlightWords.join("\n"));
function saveWords() {
  // 保留原始大小写（回显观感）；匹配侧 isMuted/highlightSegments 双方都 lower，不受存储大小写影响
  const parse = (t: string) => [...new Set(t.split("\n").map((l) => l.trim()).filter(Boolean))];
  settings.set("muteWords", parse(muteWordsText.value));
  settings.set("highlightWords", parse(highlightWordsText.value));
}

// ---- 诊断日志（AI 截断/抓取失败等实机排查；环形 500 条存本机）----
// 默认折叠：日常是无用信息，实机排障时点行展开操作
const logCount = ref(0);
const logOpen = ref(false);

function refreshLogCount() {
  try {
    logCount.value = window.airss.log.getLogs().length;
  } catch {
    logCount.value = 0;
  }
}

function copyLogs() {
  const text = window.airss.log.dumpText();
  utools.copyText(text);
  ui.toast(`已复制 ${logCount.value} 条日志`);
}

function exportLogs() {
  const path = utools.showSaveDialog({
    title: "导出诊断日志",
    defaultPath: "airss-log.txt",
    filters: [{ name: "文本", extensions: ["txt", "log"] }],
  });
  if (!path) return;
  window.airss.sys.writeTextFile(path, window.airss.log.dumpText());
  ui.toast("日志已导出");
}

function clearLogs() {
  window.airss.log.clear();
  refreshLogCount();
  ui.toast("已清空日志");
}

// ---- 关于：开源地址（GPL-3.0）----
const REPO_URL = "https://github.com/lililixxx1/AiRSS-for-utools";
function openRepo() {
  window.airss.sys.openExternal(REPO_URL);
}
</script>

<template>
  <section class="settings" role="region" aria-label="设置">
    <header class="st-top">
      <button class="btn btn-ghost btn-sm" @click="ui.view = 'main'"><I.arrowLeft />返回</button>
      <h1>设置</h1>
    </header>

    <div class="st-scroll">
      <!-- 外观 -->
      <div class="st-group">
        <h3>外观</h3>
        <div class="st-row">
          <span class="st-label">配色</span>
          <div class="seg" role="radiogroup" aria-label="配色">
            <button
              v-for="p in PALETTES"
              :key="p.id"
              :class="{ on: settings.palette === p.id }"
              @click="setPalette(p.id)"
            >
              <span class="pal-dot" aria-hidden="true"></span>{{ p.label }}
            </button>
          </div>
        </div>
        <div class="st-row">
          <span class="st-label">主题</span>
          <div class="seg" role="radiogroup" aria-label="主题">
            <button :class="{ on: settings.theme === 'light' }" @click="setTheme('light')"><I.sun />浅色</button>
            <button :class="{ on: settings.theme === 'dark' }" @click="setTheme('dark')"><I.moon />深色</button>
            <button :class="{ on: settings.theme === 'auto' }" @click="setTheme('auto')"><I.monitor />跟随系统</button>
          </div>
        </div>
        <div class="st-row">
          <span class="st-label">正文字号</span>
          <div class="seg" role="radiogroup" aria-label="正文字号">
            <button v-for="(lb, i) in ['小', '标准', '大', '特大']" :key="i" :class="{ on: settings.fontLevel === i }" @click="settings.set('fontLevel', i as 0)">{{ lb }}</button>
          </div>
        </div>
        <div class="st-row">
          <span class="st-label">默认视图</span>
          <div class="seg" role="radiogroup" aria-label="默认视图">
            <button :class="{ on: settings.viewMode === 'card' }" @click="settings.set('viewMode', 'card')">卡片</button>
            <button :class="{ on: settings.viewMode === 'list' }" @click="settings.set('viewMode', 'list')">列表</button>
          </div>
        </div>
      </div>

      <!-- AI（二期） -->
      <div class="st-group">
        <h3>
          AI 功能
          <span v-if="aiStatus && aiCfg.engine === 'utools' && !aiStatus.ready" class="badge badge-muted">环境未就绪</span>
        </h3>
        <div class="st-row">
          <div>
            <span class="st-label">AI 摘要与标题增强</span>
            <p class="st-note">默认关闭；开启后按下方「自动摘要」档位自动处理（打开文章/预取/刷新补标题标签），关闭档位时逐篇手动</p>
          </div>
          <button class="switch" :class="{ on: settings.aiEnabled }" role="switch" :aria-checked="settings.aiEnabled" @click="setAiEnabled(!settings.aiEnabled)">
            <span class="dot"></span>
          </button>
        </div>
        <div class="st-row">
          <div>
            <span class="st-label">显示 AI 优化标题</span>
            <p class="st-note">AI优化标题（清晰客观改写）、英文标题中文化；关闭则一律显示原标题</p>
          </div>
          <button class="switch" :class="{ on: settings.aiTitle }" role="switch" :aria-checked="settings.aiTitle" @click="settings.set('aiTitle', !settings.aiTitle)">
            <span class="dot"></span>
          </button>
        </div>
        <div class="st-row">
          <div>
            <span class="st-label">自动摘要</span>
            <p class="st-note">阅读时自动为当前及后续文章生成摘要（预取走 AI 额度）；关闭则逐篇显示手动 AI 按钮，刷新/新订阅也不再自动补标题/标签</p>
          </div>
          <DropdownSelect
            :model-value="settings.aiAutoCount"
            :options="[
              { value: 0, label: '关闭（手动按钮）' },
              { value: 1, label: '仅当前' },
              { value: 3, label: '连续 3 篇' },
              { value: 5, label: '连续 5 篇' },
            ]"
            aria-label="自动摘要"
            width="160px"
            @update:model-value="settings.set('aiAutoCount', Number($event) as 0)"
          />
        </div>
        <div class="st-row">
          <span class="st-label">AI 引擎</span>
          <div class="seg" role="radiogroup" aria-label="AI 引擎">
            <button :class="{ on: aiCfg.engine === 'utools' }" @click="saveAiCfg({ engine: 'utools' })">uTools AI</button>
            <button :class="{ on: aiCfg.engine === 'byok' }" @click="saveAiCfg({ engine: 'byok' })">自定义 (BYOK)</button>
          </div>
        </div>

        <template v-if="aiCfg.engine === 'utools'">
          <div class="st-row">
            <span class="st-label">模型</span>
            <DropdownSelect
              :model-value="aiCfg.model"
              :options="[{ value: '', label: '默认（deepseek-v3）' }, ...(aiStatus?.models || []).map((m) => ({ value: m.id, label: m.label }))]"
              aria-label="AI 模型"
              width="220px"
              @update:model-value="onModelPick"
            />
          </div>
          <p v-if="aiStatus && !aiStatus.ready" class="st-note warn">
            当前 uTools 版本不支持 AI 接口（需 ≥ 7.0），摘要暂不可用；可切换到自定义引擎。
          </p>
          <div v-if="aiStatus" class="st-row">
            <span class="st-label">今日额度</span>
            <span class="st-value num">打开 {{ aiStatus.quota.manual }}/{{ aiStatus.quota.manualMax }} · 后台 {{ aiStatus.quota.bg }}/{{ aiStatus.quota.bgMax }}</span>
          </div>
        </template>

        <template v-else>
          <div class="st-row">
            <span class="st-label">接口地址</span>
            <input class="input txt" v-model.trim="aiCfg.byokBaseUrl" placeholder="https://api.example.com/v1" @change="saveAiCfg({ byokBaseUrl: aiCfg.byokBaseUrl })" />
          </div>
          <div class="st-row">
            <span class="st-label">模型名</span>
            <input class="input txt" v-model.trim="aiCfg.byokModel" placeholder="gpt-4o-mini" @change="saveAiCfg({ byokModel: aiCfg.byokModel })" />
          </div>
          <div class="st-row">
            <span class="st-label">API 密钥</span>
            <div class="byok-key">
              <input class="input txt" type="password" v-model="byokKeyInput" :placeholder="byokKeySaved ? '已加密保存，输入可替换' : 'sk-…'" />
              <button class="btn btn-secondary btn-sm" @click="saveByokKey">保存</button>
            </div>
          </div>
          <div class="st-row">
            <div>
              <span class="st-label">允许 http 地址</span>
              <p class="st-note">仅自建内网网关才勾选；公网明文传输密钥有泄露风险</p>
            </div>
            <button class="switch" :class="{ on: aiCfg.byokAllowHttp }" role="switch" :aria-checked="aiCfg.byokAllowHttp" @click="saveAiCfg({ byokAllowHttp: !aiCfg.byokAllowHttp })">
              <span class="dot"></span>
            </button>
          </div>
          <p class="st-note">自定义引擎走 OpenAI 兼容接口（/chat/completions），不消耗 uTools 额度；地址变更后重定向将被拒绝。</p>
        </template>

        <p class="st-note">开启后，文章标题与正文（截断至约 2000 字）会发送至所选 AI 服务用于生成摘要。</p>
      </div>

      <!-- 过滤（PLAN-V1.3 B）-->
      <div class="st-group">
        <h3>过滤</h3>
        <div class="st-row stack">
          <div>
            <span class="st-label">静音词</span>
            <p class="st-note">每行一个词，任一词命中标题或摘要即从列表隐藏；顶部工具栏可临时暂停查看。「全部已读」只作用于当前列表（静音项不会被一键已读）；顶部统计计数不受静音影响</p>
          </div>
          <textarea class="input words-area" v-model="muteWordsText" rows="3" placeholder="例：抽奖" spellcheck="false" @blur="saveWords"></textarea>
        </div>
        <div class="st-row stack">
          <div>
            <span class="st-label">高亮词</span>
            <p class="st-note">每行一个词，在列表标题中高亮显示。与搜索词合计上限 3 个：搜索词优先，搜索词满 3 个时高亮词暂不显示</p>
          </div>
          <textarea class="input words-area" v-model="highlightWordsText" rows="2" placeholder="例：Rust" spellcheck="false" @blur="saveWords"></textarea>
        </div>
      </div>

      <!-- 通知 -->
      <div class="st-group">
        <h3>通知</h3>
        <div class="st-row">
          <div>
            <span class="st-label">新文章通知</span>
            <p class="st-note">每个订阅源有新文章时发一条系统通知</p>
          </div>
          <button class="switch" :class="{ on: settings.notifyEnabled }" role="switch" :aria-checked="settings.notifyEnabled" @click="settings.set('notifyEnabled', !settings.notifyEnabled)">
            <span class="dot"></span>
          </button>
        </div>
      </div>

      <!-- 数据 -->
      <div class="st-group">
        <h3>数据</h3>
        <div class="st-row">
          <span class="st-label">刷新频率</span>
          <DropdownSelect
            :model-value="settings.refreshMin"
            :options="[
              { value: 15, label: '15 分钟' },
              { value: 30, label: '30 分钟' },
              { value: 60, label: '1 小时' },
              { value: 360, label: '6 小时' },
            ]"
            aria-label="刷新频率"
            width="140px"
            @update:model-value="settings.set('refreshMin', Number($event))"
          />
        </div>
        <div class="st-row">
          <span class="st-label">每源保留</span>
          <DropdownSelect
            :model-value="settings.keepPerFeed"
            :options="[
              { value: 50, label: '50 篇' },
              { value: 100, label: '100 篇' },
              { value: 200, label: '200 篇（默认）' },
              { value: 500, label: '500 篇' },
            ]"
            aria-label="每源保留"
            width="140px"
            @update:model-value="settings.set('keepPerFeed', Number($event))"
          />
        </div>
        <div class="st-row">
          <span class="st-label">订阅备份</span>
          <button class="btn btn-secondary btn-sm" @click="exportOpml"><I.download />导出 OPML</button>
        </div>
        <div class="st-row stack">
          <button class="log-head" type="button" :aria-expanded="logOpen" @click="logOpen = !logOpen">
            <span class="st-label">诊断日志</span>
            <span class="log-meta">
              <span class="st-value num">{{ logCount }} 条</span>
              <I.chevronDown class="chev" :class="{ open: logOpen }" />
            </span>
          </button>
          <p class="st-note">AI 摘要 / 抓取问题的排查记录（近 500 条，存本机）</p>
          <div v-if="logOpen" class="log-actions">
            <button class="btn btn-ghost btn-sm" @click="copyLogs"><I.copy />复制</button>
            <button class="btn btn-ghost btn-sm" @click="exportLogs"><I.download />导出</button>
            <button class="btn btn-ghost btn-sm" @click="clearLogs">清空</button>
          </div>
        </div>
        <div class="st-row">
          <span class="st-label">危险区</span>
          <button class="btn btn-danger-outline btn-sm" @click="askClear"><I.trash />清空所有数据…</button>
        </div>
      </div>

      <!-- 关于 -->
      <div class="st-group">
        <h3>关于</h3>
        <div class="st-row"><span class="st-label">版本</span><span class="st-value num">1.1.0（二期 AI 增强）</span></div>
        <div class="st-row">
          <span class="st-label">开源地址</span>
          <button class="repo-link" type="button" @click="openRepo">github.com/lililixxx1/AiRSS-for-utools</button>
        </div>
        <div class="st-row">
          <span class="st-label">开源协议</span>
          <span class="st-value">GPL-3.0 · 数据仅存本机（随 uTools 云同步）</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings { position: absolute; inset: 0; z-index: var(--z-reader); background: var(--bg-panel); display: flex; flex-direction: column; animation: reader-in var(--t-slow) var(--ease-out); }
@keyframes reader-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }

.st-top { height: 52px; flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid var(--border); }
.st-top h1 { font-size: 16px; font-weight: 650; }

.st-scroll { flex: 1; overflow-y: auto; padding: 16px; }
.st-group {
  max-width: 560px; margin: 0 auto 12px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-1); padding: 4px 16px;
}
.st-group h3 { font-size: 13px; font-weight: 650; color: var(--text-2); padding: 12px 0 4px; display: flex; align-items: center; gap: 8px; }
.st-group.dim { opacity: 0.85; }
.st-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 6px 0; border-top: 1px solid var(--border); }
.st-row:first-of-type { border-top: none; }
.st-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.st-value { font-size: 12px; color: var(--text-2); }
.st-note { font-size: 12px; color: var(--text-2); line-height: 1.5; padding: 4px 0 12px; }

.seg { display: flex; border: 1px solid var(--border-strong); border-radius: var(--r-md); overflow: hidden; }
/* 配色 swatch：取色一律走 --p-sw-* 令牌（tokens.css data-palette 块），组件零私有 hex */
.pal-dot {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, var(--p-sw-panel) 50%, var(--p-sw-accent) 50%);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.seg button {
  height: 32px; padding: 0 12px; border: none; background: transparent;
  font-family: inherit; font-size: 13px; font-weight: 500; color: var(--text-2); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.seg button:hover { background: var(--bg-hover); }
.seg button.on { background: var(--bg-selected); color: var(--accent-deep); }
.seg button:active { background: var(--bg-active); }

.sel { width: 160px; height: 32px; }
.txt { width: 220px; height: 32px; }
.st-row.stack { flex-direction: column; align-items: stretch; }
.words-area { width: 100%; height: auto; min-height: 56px; resize: vertical; font-family: inherit; font-size: 13px; line-height: 1.7; padding: 8px 10px; }
.byok-key { display: flex; align-items: center; gap: 8px; }
/* 诊断日志折叠头：默认收起，点行展开操作（aria-expanded 同步；reduced-motion 下 base.css 拦截 transform 过渡，瞬时翻转） */
.log-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 36px; padding: 2px 6px; margin: 0 -6px;
  border: none; border-radius: var(--r-md); background: transparent; font-family: inherit; cursor: pointer;
}
.log-head:hover { background: var(--bg-hover); }
.log-head:active { background: var(--bg-active); }
.log-meta { display: flex; align-items: center; gap: 8px; }
.log-head .chev { font-size: 14px; color: var(--text-2); transition: transform var(--t-fast) var(--ease-out); }
.log-head .chev.open { transform: rotate(180deg); }
.log-actions { display: flex; gap: 8px; padding: 0 0 8px; }
/* 开源地址：链接样式按钮（令牌取色，无私有 hex；:active 排 :hover 后，源序纪律） */
.repo-link {
  border: none; background: transparent; font-family: inherit; font-size: 12px;
  color: var(--accent-deep); cursor: pointer; padding: 2px 4px; margin: 0 -4px;
  border-radius: var(--r-sm); text-decoration: underline; text-underline-offset: 2px;
}
.repo-link:hover { color: var(--accent-strong); }
.repo-link:active { color: var(--accent-active); background: var(--bg-active); }
.st-note.warn { color: var(--danger-text); }
/* .switch 全局类在 base.css（PLAN-POLISH D3 提取） */
</style>
