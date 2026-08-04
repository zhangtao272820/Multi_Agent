<template>
  <ClientOnly>
    <ClawhiveLoginGate v-if="needAuth && authReady && !isLoggedIn" @success="onLoginOk" />
  </ClientOnly>
  <div v-if="!needAuth || (authReady && isLoggedIn)" class="rag-app-root relative min-h-screen bg-slate-950 text-slate-100">
    <!-- Three.js银河系背景 -->
    <div class="absolute inset-0 z-0 overflow-hidden">
      <canvas ref="starCanvas" class="w-full h-full"></canvas>
    </div>

    <div class="relative z-10 flex h-screen">
      <div class="w-72 bg-slate-950/80 border-r border-white/10 flex flex-col">
        <div class="p-4 border-b border-white/10">
          <h2 class="text-xl font-semibold tracking-wide">文曲 · 文档助手</h2>
          <div class="mt-1 text-xs text-slate-300/70">基于已上传资料 · 本地向量检索</div>
        </div>

        <div class="p-4 border-b border-white/10 bg-white/5">
          <h3 class="text-xs font-semibold text-slate-200/70 uppercase tracking-wider mb-2">检索学习</h3>
          <div class="grid grid-cols-2 gap-2 text-[11px] text-slate-200/80">
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">反馈样本</div>
              <div class="font-semibold text-sky-200">{{ intel.learning?.total ?? 0 }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">好评率</div>
              <div class="font-semibold text-emerald-200">{{ pct(intel.learning?.okRate) }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">经验向量</div>
              <div class="font-semibold text-violet-200">{{ intel.experience?.count ?? 0 }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">已晋级</div>
              <div class="font-semibold text-amber-200">{{ intel.promptEvolution?.evolvedHintCount ?? 0 }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">A/B 实验</div>
              <div class="font-semibold text-cyan-200">{{ intel.promptAb?.enabled ? '开' : '关' }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">跨 Agent</div>
              <div class="font-semibold text-fuchsia-200">{{ intel.crossAgent?.enabled ? (intel.crossAgent?.linkedUsers ?? 0) : '关' }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">进程内重排</div>
              <div class="font-semibold text-lime-200">{{ intel.embeddingRerank?.enabled ? 'embedding' : '关' }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">ONNX</div>
              <div class="font-semibold text-amber-200">{{ intel.onnxRerank?.sessionReady ? '就绪' : (intel.onnxRerank?.enabled ? '待模型' : '关') }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">共享身份</div>
              <div class="font-semibold text-indigo-200">{{ intel.sharedIdentity?.enabled ? (intel.sharedIdentity?.mappedSessions ?? 0) : '关' }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5 col-span-2">
              <div class="text-slate-400/70">Bandit 重排臂</div>
              <div class="font-semibold text-teal-200 text-[10px] mt-0.5">
                {{ intel.retrievalBandit?.enabled ? topBanditArm : '关' }}
              </div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">专用重排</div>
              <div class="font-semibold text-orange-200">{{ intel.dedicatedRerank?.urlConfigured ? '已配' : '未配' }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5">
              <div class="text-slate-400/70">OIDC</div>
              <div class="font-semibold text-blue-200">{{ intel.oidc?.enabled ? '开' : '关' }}</div>
            </div>
            <div class="rounded border border-white/10 bg-slate-950/30 px-2 py-1.5 col-span-2">
              <div class="text-slate-400/70">A/B 显著性 / 定时整理</div>
              <div class="font-semibold text-slate-100 text-[10px] mt-0.5">
                <span v-if="intel.abSignificance?.significant" class="text-emerald-300">可自动晋级</span>
                <span v-else class="text-slate-400">{{ abSignificanceHint }}</span>
                <span class="text-slate-500 mx-1">·</span>
                <span>{{ intel.autoCurator?.enabled ? '定时开' : '定时空' }}</span>
              </div>
            </div>
          </div>
          <div class="mt-2 flex gap-2">
            <button
              type="button"
              class="flex-1 text-[11px] rounded border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-1 text-slate-200 disabled:opacity-50"
              :disabled="intelCurating"
              @click="runCurate"
            >
              {{ intelCurating ? '整理中…' : '整理学习' }}
            </button>
            <button
              type="button"
              class="flex-1 text-[11px] rounded border border-rose-400/20 bg-rose-500/10 hover:bg-rose-500/20 px-2 py-1 text-rose-100 disabled:opacity-50"
              :disabled="intelResetting"
              @click="resetLearning('learning')"
            >
              清空
            </button>
          </div>
          <button
            type="button"
            class="mt-2 w-full text-[11px] rounded border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-1 text-slate-200"
            @click="refreshIntel"
          >
            刷新学习状态
          </button>
        </div>

        <div class="p-4 border-b border-white/10 bg-white/5">
          <h3 class="text-xs font-semibold text-slate-200/70 uppercase tracking-wider mb-3">我能帮你</h3>
          <div class="space-y-2">
            <div class="flex items-center text-xs text-slate-200/80 bg-sky-500/10 p-2 rounded border border-sky-400/20">
              <span class="w-2 h-2 bg-sky-300 rounded-full mr-2"></span>
              上传并索引文档
            </div>
            <div class="flex items-center text-xs text-slate-200/80 bg-emerald-500/10 p-2 rounded border border-emerald-400/20">
              <span class="w-2 h-2 bg-emerald-300 rounded-full mr-2"></span>
              根据资料回答问题
            </div>
            <div class="flex items-center text-xs text-slate-200/80 bg-violet-500/10 p-2 rounded border border-violet-400/20">
              <span class="w-2 h-2 bg-violet-300 rounded-full mr-2"></span>
              查看知识库文档列表
            </div>
          </div>
        </div>

        <div class="p-4 border-b border-white/10">
          <button
            @click="triggerUpload"
            class="w-full bg-sky-500/90 text-white px-4 py-2.5 rounded-lg font-semibold hover:bg-sky-400 transition-colors flex items-center justify-center shadow-sm shadow-sky-500/20 disabled:opacity-60"
            :disabled="isUploading"
          >
            <span v-if="isUploading" class="animate-spin mr-2">⏳</span>
            {{ isUploading ? '解析中...' : '上传非结构化文档' }}
          </button>
          <div class="mt-2 text-[10px] text-slate-300/70 text-center text-wrap">支持 PDF, TXT, DOC, DOCX, MD, CSV, JSON, ZIP, 图片 (PNG, JPG...)</div>
          <input
            type="file"
            ref="fileInput"
            class="hidden"
            accept=".pdf,.txt,.doc,.docx,.md,.csv,.json,.zip,.png,.jpg,.jpeg,.bmp,.tiff,.gif,.webp"
            @change="handleFileUpload"
          />
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <h3 class="text-xs font-semibold text-slate-200/70 uppercase tracking-wider mb-3">知识库</h3>
          <ul class="space-y-3">
            <li
              v-for="doc in documents"
              :key="doc.name"
              :id="`doc-item-${sanitizeDomId(doc.name)}`"
              :class="[
                'group relative rounded-lg border p-3 shadow-sm shadow-black/20 transition-all',
                highlightedDocName === doc.name
                  ? 'bg-sky-400/15 border-sky-300/60 ring-1 ring-sky-300/40'
                  : 'bg-white/5 border-white/10 hover:border-sky-300/30'
              ]"
            >
              <div class="flex items-center justify-between mb-1">
                <div class="flex items-center min-w-0">
                  <div :class="['w-2 h-2 rounded-full mr-2 shrink-0', getDocColor(doc.type)]"></div>
                  <span class="truncate text-xs font-semibold text-slate-100/90">{{ doc.name }}</span>
                </div>
                <button @click="confirmDelete(doc.name)" class="text-slate-400/60 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
              <div v-if="doc.summary" class="text-[10px] text-slate-200/70 line-clamp-2 leading-relaxed mt-1 italic border-t pt-1 border-white/10">
                {{ doc.summary }}
              </div>
            </li>
            <li v-if="documents.length === 0" class="text-sm text-slate-300/70 italic text-center py-4">暂无文档库内容</li>
          </ul>
        </div>
      </div>

      <!-- 历史会话侧栏（Checkpointer 式） -->
      <aside
        class="flex flex-col border-r border-white/10 bg-slate-950/70 transition-all duration-200 overflow-hidden"
        :class="historyPanelOpen ? 'w-64' : 'w-0'"
        aria-label="历史会话"
      >
        <div class="w-64 flex flex-col h-full">
          <div class="p-3 border-b border-white/10 flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-slate-200 uppercase tracking-wider">历史会话</span>
            <button
              type="button"
              class="text-[11px] rounded border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-0.5 text-slate-200"
              @click="newSession"
            >
              新会话
            </button>
          </div>
          <div v-if="!sessionHistoryItems.length" class="p-4 text-xs text-slate-400 italic">
            暂无历史记录，发送消息后会自动保存。
          </div>
          <ul v-else class="rag-history-list flex-1 min-h-0">
            <li
              v-for="item in sessionHistoryItems"
              :key="item.id"
              class="rag-history-row"
              :class="{ active: item.id === conversationId }"
            >
              <button
                type="button"
                class="rag-history-item"
                :title="item.title"
                @click="switchSession(item.id)"
              >
                <span class="rag-history-item-title">{{ item.title }}</span>
                <span class="rag-history-item-meta">
                  {{ formatHistoryTime(item.updatedAt) }} · {{ item.userMessageCount }} 轮
                </span>
              </button>
              <div class="rag-history-item-actions">
                <button
                  type="button"
                  class="rag-history-action-btn"
                  title="重命名"
                  @click.stop="renameSessionHistory(item)"
                >
                  重命名
                </button>
                <button
                  type="button"
                  class="rag-history-action-btn danger"
                  title="删除"
                  @click.stop="deleteSessionHistory(item.id)"
                >
                  删除
                </button>
              </div>
            </li>
          </ul>
        </div>
      </aside>

      <div class="flex-1 flex flex-col bg-slate-950/40 border-l border-white/5 min-w-0">
        <div class="px-4 py-2.5 border-b border-white/10 flex items-center justify-between gap-3 bg-slate-950/50">
          <div class="min-w-0">
            <h1 class="text-sm font-semibold text-slate-100 truncate">文曲 · 文档助手</h1>
            <div class="text-[10px] text-slate-400 truncate">会话 {{ conversationId ? conversationId.slice(0, 8) + '…' : '未开始' }}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              class="text-[11px] rounded border px-2 py-1 transition-colors"
              :class="historyPanelOpen ? 'border-sky-400/40 bg-sky-500/15 text-sky-100' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'"
              @click="historyPanelOpen = !historyPanelOpen"
            >
              历史
            </button>
            <button
              type="button"
              class="text-[11px] rounded border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-1 text-slate-200"
              @click="newSession"
            >
              新会话
            </button>
          </div>
        </div>

        <AppModal
          v-model="appModal.open"
          :mode="appModal.mode"
          :title="appModal.title"
          :message="appModal.message"
          :input-value="appModal.inputValue"
          :input-placeholder="appModal.inputPlaceholder"
          @confirm="onAppModalConfirm"
          @cancel="onAppModalCancel"
        />
        <div v-if="modal.show" class="fixed inset-0 z-50 flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="closeModal"></div>
          <div class="relative bg-white w-full max-w-sm mx-4 rounded-lg shadow-lg border">
            <div :class="['px-4 py-3 rounded-t-lg', modal.type === 'error' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white']">
              <h3 class="text-sm font-semibold">{{ modal.title }}</h3>
            </div>
            <div class="px-4 py-3 text-sm whitespace-pre-wrap text-gray-700">
              {{ modal.message }}
            </div>
            <div class="px-4 py-3 border-t flex justify-end">
              <button @click="closeModal" class="px-4 py-1.5 bg-gray-800 text-white rounded hover:bg-gray-900 transition">
                知道了
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧“来源证据”抽屉 -->
        <div v-if="sourceDrawer.show" class="fixed inset-0 z-40">
          <div class="absolute inset-0 bg-black/40" @click="closeSourceDrawer"></div>
          <aside class="absolute right-0 top-0 h-full w-full max-w-md bg-slate-950/95 border-l border-white/10 backdrop-blur shadow-2xl shadow-black/40 flex flex-col">
            <div class="px-4 py-4 border-b border-white/10 flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-xs text-slate-300/70">来源证据</div>
                <div class="mt-1 text-sm font-semibold text-slate-100 truncate">{{ sourceDrawer.docName || '未选择' }}</div>
                <div v-if="sourceDrawer.type" class="mt-1 text-[11px] text-slate-300/70">类型：{{ sourceDrawer.type }}</div>
              </div>
              <button
                class="shrink-0 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-1 text-xs text-slate-100"
                @click="closeSourceDrawer"
              >
                关闭
              </button>
            </div>

            <div class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              <section v-if="sourceDrawer.summary" class="rounded-lg border border-white/10 bg-white/5 p-3">
                <h4 class="text-xs font-semibold text-sky-200 mb-2">文档摘要</h4>
                <div class="text-xs text-slate-100/90 whitespace-pre-wrap leading-relaxed">{{ sourceDrawer.summary }}</div>
              </section>

              <section class="rounded-lg border border-white/10 bg-white/5 p-3">
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-xs font-semibold text-sky-200">命中片段</h4>
                  <div class="text-[11px] text-slate-300/70">共 {{ sourceDrawer.snippets.length }} 条</div>
                </div>

                <div v-if="sourceDrawer.snippets.length === 0" class="text-xs text-slate-300/70">
                  当前消息未解析到该来源的命中片段。你可以继续追问，或确认回答里是否包含正确的“来源”。
                </div>

                <ul v-else class="space-y-3">
                  <li v-for="(snip, idx) in sourceDrawer.snippets" :key="idx" class="rounded-md border border-white/10 bg-slate-950/20 p-2">
                    <div class="flex items-center justify-between gap-2">
                      <div class="text-[11px] text-slate-300/70 truncate">{{ snip.source }}</div>
                      <button
                        class="rounded border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-0.5 text-[11px] text-slate-100"
                        @click="copyToClipboard(snip.content)"
                      >
                        复制
                      </button>
                    </div>
                    <div class="mt-1 text-xs text-slate-100/90 whitespace-pre-wrap leading-relaxed">{{ snip.content }}</div>
                  </li>
                </ul>
              </section>
            </div>
          </aside>
        </div>

        <div v-if="sessionSwitching" class="rag-chat-loading flex-1">
          <span class="rag-chat-loading-dot" aria-hidden="true"></span>
          <span>正在加载会话…</span>
        </div>
        <div v-else class="flex-1 overflow-y-auto p-6 space-y-5" ref="chatContainer">
          <div
            v-for="(msg, index) in messages"
            :key="msg.turnId != null ? `turn-${msg.turnId}-${msg.role}` : `msg-${index}`"
            :class="['flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start']"
          >
            <div
              v-if="msg.role === 'assistant'"
              class="shrink-0 mt-1 w-8 h-8 rounded-full bg-sky-500/15 border border-sky-400/25 flex items-center justify-center text-sm"
              aria-hidden="true"
            >
              📄
            </div>
            <div
              :class="[
                'max-w-[82%] px-4 py-3 rounded-2xl shadow-sm',
                msg.role === 'user'
                  ? 'bg-sky-500/90 text-white shadow-sky-500/10 rounded-br-md'
                  : 'bg-slate-950/40 border border-white/10 text-slate-100/90 backdrop-blur rounded-bl-md'
              ]"
            >
              <!-- 用户消息 -->
              <template v-if="msg.role === 'user'">
                <div v-if="editingTurnId === msg.turnId" class="space-y-2">
                  <textarea
                    v-model="editDraft"
                    rows="3"
                    class="w-full rounded-lg border border-white/20 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-300/60 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                    placeholder="编辑后重发…"
                  />
                  <div class="flex gap-2 justify-end">
                    <button type="button" class="msg-action-btn" @click="cancelEditTurn">取消</button>
                    <button type="button" class="msg-action-btn msg-action-primary" @click="submitEditResend(msg)">重发</button>
                  </div>
                </div>
                <div v-else class="user-message-text text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {{ msg.content }}
                </div>
                <div v-if="msg.turnId > 0 && editingTurnId !== msg.turnId" class="mt-2 flex gap-2 justify-end flex-wrap">
                  <button
                    v-if="msg.content?.trim()"
                    type="button"
                    class="msg-action-btn"
                    @click="copyMessageText(msg.content, msg.turnId)"
                  >
                    {{ copyAckTurnId === msg.turnId ? '已复制' : '复制' }}
                  </button>
                  <button type="button" class="msg-action-btn" :disabled="isTurnRunning(msg.turnId)" @click="startEditTurn(msg)">编辑</button>
                  <button type="button" class="msg-action-btn" :disabled="isTurnRunning(msg.turnId)" @click="withdrawTurn(msg.turnId)">撤回</button>
                  <button
                    v-if="typeof msg.userMessageIndex === 'number'"
                    type="button"
                    class="msg-action-btn"
                    :disabled="isLoading || isTurnRunning(msg.turnId)"
                    @click="regenerateTurn(msg)"
                  >
                    重新生成
                  </button>
                </div>
              </template>

              <!-- 助手消息 -->
              <template v-else>
              <div class="text-[10px] font-medium text-sky-200/70 mb-1">
                文曲
              </div>

              <div
                v-if="processSteps(msg).length || (msg.status && isTurnRunning(msg.turnId))"
                class="rag-process-panel mb-2"
              >
                <button
                  type="button"
                  class="rag-process-toggle"
                  @click="toggleProcessPanel(msg.turnId)"
                >
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-sky-300" :class="{ 'animate-pulse': isTurnRunning(msg.turnId) }"></span>
                  <span>{{ isTurnRunning(msg.turnId) ? '思考中' : '思考过程' }}</span>
                  <span v-if="processElapsedLabel(msg)" class="rag-process-elapsed">{{ processElapsedLabel(msg) }}</span>
                  <span class="rag-process-count">{{ processSteps(msg).length }} 步</span>
                  <span class="rag-process-chevron">{{ isProcessExpanded(msg) ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isProcessExpanded(msg)" class="rag-process-steps">
                  <div
                    v-for="(step, si) in processSteps(msg)"
                    :key="si"
                    :class="['rag-process-step', `kind-${step.kind}`]"
                  >
                    <span class="rag-process-dot"></span>
                    <span class="rag-process-text">{{ step.text }}</span>
                    <span v-if="stepDurationLabel(msg, si)" class="rag-process-step-ms">{{ stepDurationLabel(msg, si) }}</span>
                  </div>
                  <div
                    v-if="isTurnRunning(msg.turnId) && msg.status && !processSteps(msg).some(s => s.text === msg.status)"
                    class="rag-process-step kind-status"
                  >
                    <span class="rag-process-dot animate-pulse"></span>
                    <span class="rag-process-text">{{ msg.status }}</span>
                  </div>
                </div>
              </div>

              <div v-if="msg.status && !processSteps(msg).length && !isTurnRunning(msg.turnId)" class="text-xs text-sky-300/80 mb-2 flex items-center gap-1.5">
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-sky-300 animate-pulse"></span>
                {{ msg.status }}
              </div>

              <div
                v-if="msg.content?.trim() || evidenceCardList(msg).length"
                class="assistant-message-shell"
              >
                <div
                  v-if="extractAnswerBody(msg.content).text"
                  class="formatted-answer assistant-render rag-answer-main"
                  :data-msg-index="index"
                  v-html="formatAssistantMessage(msg, index)"
                  @click="(e) => handleFormattedAnswerClick(e, msg)"
                ></div>

                <div
                  v-if="!msg.status && (sourceChipList(msg).length || evidenceCardList(msg).length || msg.retrievalMeta)"
                  class="rag-reply-footer"
                >
                  <div class="rag-footer-row">
                    <div v-if="sourceChipList(msg).length" class="rag-footer-sources">
                      <span class="rag-sources-label">引用自</span>
                      <div class="rag-source-chips">
                        <button
                          v-for="(src, si) in sourceChipList(msg)"
                          :key="`${index}-src-${si}`"
                          type="button"
                          class="rag-source-chip"
                          @click="handleSourceChipClick(src, msg)"
                        >
                          {{ shortDocName(src) }}
                        </button>
                      </div>
                    </div>
                    <div class="rag-footer-actions">
                      <span
                        v-if="msg.retrievalMeta?.rerankMode"
                        class="rag-strategy-hint"
                        :title="msg.retrievalMeta.rerankMode"
                      >
                        {{ shortRerankLabel(msg.retrievalMeta.rerankMode) }}
                      </span>
                      <button
                        v-if="evidenceCardList(msg).length"
                        type="button"
                        class="rag-evidence-toggle"
                        :aria-expanded="msg.showEvidence === true"
                        @click="toggleEvidence(msg)"
                      >
                        <span>{{ msg.showEvidence ? '收起依据' : '查看依据' }}</span>
                        <span class="rag-evidence-toggle-count">{{ evidenceCardList(msg).length }} 条</span>
                      </button>
                    </div>
                  </div>

                  <Transition name="rag-evidence-collapse">
                    <div
                      v-if="msg.showEvidence && evidenceCardList(msg).length"
                      class="rag-evidence-panel"
                    >
                      <div class="rag-evidence-list">
                        <div
                          v-for="(item, ei) in evidenceCardList(msg)"
                          :key="`${index}-ev-${ei}`"
                          class="rag-evidence-item"
                        >
                          <div class="rag-evidence-item-head">
                            <span class="rag-evidence-index">{{ ei + 1 }}</span>
                            <button
                              v-if="item.source && item.source !== 'unknown'"
                              type="button"
                              class="rag-evidence-source-inline"
                              @click="handleSourceChipClick(item.source, msg)"
                            >
                              {{ shortDocName(item.source) }}
                            </button>
                          </div>
                          <div
                            class="rag-evidence-quote"
                            v-html="formatEvidencePreview(item.content, { compact: true })"
                          ></div>
                        </div>
                      </div>
                    </div>
                  </Transition>
                </div>
              </div>

              <div
                v-if="msg.content && index > 0 && msg.turnId > 0"
                class="mt-1.5 pt-1.5 border-t border-white/10"
              >
                <template v-if="!turnFeedbackSubmitted(msg)">
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="text-[11px] rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
                      :disabled="feedbackSendingUserIndex === feedbackUserIndexForMessage(msg)"
                      @click="sendFeedback(msg, index, 1)"
                    >
                      有帮助
                    </button>
                    <button
                      type="button"
                      class="text-[11px] rounded border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
                      :disabled="feedbackSendingUserIndex === feedbackUserIndexForMessage(msg)"
                      @click="sendFeedback(msg, index, -1)"
                    >
                      不准确
                    </button>
                  </div>
                </template>
                <p v-else class="rag-feedback-ack">{{ turnFeedbackAckText(msg) }}</p>
              </div>
              </template>
            </div>
          </div>

        </div>

        <div class="p-4 bg-slate-950/60 border-t border-white/10">
          <div class="rag-input-hint">{{ isLoading ? 'Esc 或点击取消停止' : 'Enter 发送' }}</div>
          <div class="flex space-x-2">
            <textarea
              v-model="userInput"
              rows="2"
              @keydown="onInputKeydown"
              placeholder="输入问题，我会根据已上传的文档回答…"
              class="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-slate-100 placeholder:text-slate-300/60 focus:outline-none focus:ring-2 focus:ring-sky-400/40 resize-none min-h-[44px]"
            />
            <button
              type="button"
              class="rag-send-cancel bg-sky-500/90 text-white px-6 py-2 rounded-lg hover:bg-sky-400 transition disabled:opacity-50 font-semibold shrink-0 self-end"
              :class="{ 'is-cancel': isLoading }"
              :disabled="!isLoading && !userInput.trim()"
              @click="onSendOrCancel"
            >
              {{ isLoading ? '取消' : '发送' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, nextTick, computed, watch } from 'vue';

const runtimeConfig = useRuntimeConfig()
const needAuth = computed(() => String(runtimeConfig.public?.agentBrowserAuth ?? '1') !== '0')
const { isLoggedIn, ready: authReady, loadFromStorage, authHeaders, token: clawhiveToken } = useClawhiveLogin()
function onLoginOk() {
  loadFromStorage()
}
function withAuthHeaders(init = {}) {
  const h = authHeaders()
  const base = init.headers || {}
  if (base instanceof Headers) {
    Object.entries(h).forEach(([k, v]) => base.set(k, v))
    return { ...init, headers: base }
  }
  return { ...init, headers: { ...base, ...h } }
}
import * as THREE from 'three';
import MarkdownIt from 'markdown-it';
import * as echarts from 'echarts';
import AppModal from './components/AppModal.vue';
import { purgeAllForbiddenClientSessionKeys } from '#agent-shared/agentSessionClientStorage';

const RAG_SESSION_KEY = 'rag_session_id';

function tabSessionStorage() {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage;
}

function setTabRagSessionId(id) {
  try {
    tabSessionStorage()?.setItem(RAG_SESSION_KEY, id);
  } catch {}
}

function clearTabRagSessionId() {
  try {
    tabSessionStorage()?.removeItem(RAG_SESSION_KEY);
  } catch {}
}

function readTabRagSessionId() {
  try {
    return tabSessionStorage()?.getItem(RAG_SESSION_KEY) || '';
  } catch {
    return '';
  }
}

useHead({ title: '文曲 · RAG Agent' });

const fileInput = ref(null);
const isUploading = ref(false);
const isLoading = ref(false);
const liveProcessMs = ref(0);
const turnSeq = ref(0);
const activeTurnId = ref(0);
const editingTurnId = ref(null);
const editDraft = ref('');
const copyAckTurnId = ref(null);
let copyAckTimer = null;
const collapsedProcessTurns = ref(new Set());
let chatAbortController = null;
let processTickTimer = null;
const modal = ref({ show: false, title: '', message: '', type: 'success' });
const userInput = ref('');
const documents = ref([]);
const DEFAULT_WELCOME = {
  role: 'assistant',
  content: '你好！我是文档助手。\n先在左侧上传 PDF、Word、TXT 等资料，然后直接问我文档里的内容就好。',
  turnId: 0,
  processSteps: [],
};
const messages = ref([{ ...DEFAULT_WELCOME }]);
const chatContainer = ref(null);
const starCanvas = ref(null);
const conversationId = ref('');
const historyPanelOpen = ref(true);
const sessionHistoryItems = ref([]);
const sessionSwitching = ref(false);
const ragUserId = ref('');
const feedbackByUserIndex = ref({});
const feedbackAckByUserIndex = ref({});
const feedbackSendingUserIndex = ref(null);
const appModal = ref({
  open: false,
  mode: 'alert',
  title: '',
  message: '',
  inputValue: '',
  inputPlaceholder: '',
  pendingAction: null,
});
const highlightedDocName = ref('');
const sourceDrawer = ref({
  show: false,
  docName: '',
  sourceName: '',
  summary: '',
  type: '',
  snippets: []
});
const intel = ref({
  learning: { total: 0, okRate: null },
  experience: { count: 0 },
  promptEvolution: { patchCount: 0, evolvedHintCount: 0, promotableCount: 0 },
  promptAb: { enabled: false, treatmentPercent: 50 },
  crossAgent: { enabled: false, linkedUsers: 0 },
  localRerank: { enabled: false },
  embeddingRerank: { enabled: false },
  onnxRerank: { enabled: false, sessionReady: false },
  sharedIdentity: { enabled: false, mappedSessions: 0 },
  abSignificance: { significant: false, treatmentN: 0, controlN: 0 },
  autoCurator: { enabled: false },
  retrievalBandit: { enabled: false, arms: [] },
  dedicatedRerank: { enabled: false, urlConfigured: false },
  oidc: { enabled: false },
  evalBaseline: null,
});
const intelCurating = ref(false);
const intelResetting = ref(false);

let scene = null;
let camera = null;
let renderer = null;
let galaxyPoints = null;
let backgroundPoints = null;
let coreSprite = null;
let nebulaSprites = [];
let nebulaSharedTexture = null;
let animationId = null;
let highlightTimer = null;

const copyToClipboard = async (text) => {
  const s = String(text ?? '');
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
};

const closeSourceDrawer = () => {
  sourceDrawer.value = { show: false, docName: '', sourceName: '', summary: '', type: '', snippets: [] };
};

const closeModal = () => {
  modal.value.show = false;
};

const ensureRagUserId = () => {
  if (typeof window === 'undefined') return 'anonymous';
  try {
    const { user: clawUser, token: clawTok, loadFromStorage } = useClawhiveLogin();
    if (!clawTok.value) loadFromStorage();
    const fromLogin = String(clawUser.value?.userId || '').trim();
    if (fromLogin) {
      ragUserId.value = fromLogin;
      window.localStorage.setItem('rag_user_id', fromLogin);
      return fromLogin;
    }
    const existing = window.localStorage.getItem('rag_user_id');
    if (existing) {
      ragUserId.value = existing;
      return existing;
    }
    const id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `u_${Date.now().toString(36)}`;
    window.localStorage.setItem('rag_user_id', id);
    ragUserId.value = id;
    return id;
  } catch {
    return 'anonymous';
  }
};

const generateSessionId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

const formatHistoryTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
};

const deriveSessionTitleFromMessages = () => {
  const first = messages.value.find((m) => m.role === 'user' && String(m.content || '').trim());
  if (!first?.content) return '新会话';
  const t = String(first.content).replace(/\s+/g, ' ').trim();
  return t.length > 36 ? `${t.slice(0, 36)}…` : t;
};

const persistSessionHistoryList = () => {
  // 权威在服务端；内存列表仅截断
  sessionHistoryItems.value = sessionHistoryItems.value.slice(0, 80);
};

const loadSessionHistoryList = () => {
  if (typeof window === 'undefined') return;
  purgeAllForbiddenClientSessionKeys();
  touchCurrentSessionHistory({ bump: false });
  void fetchServerSessionHistory();
};

const touchCurrentSessionHistory = (opts = {}) => {
  const bump = opts.bump === true;
  const id = conversationId.value;
  if (!id) return;
  const now = new Date().toISOString();
  const title = deriveSessionTitleFromMessages();
  const userMessageCount = messages.value.filter((m) => m.role === 'user').length;
  const messageCount = messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').length;
  const idx = sessionHistoryItems.value.findIndex((s) => s.id === id);
  if (idx >= 0) {
    const row = sessionHistoryItems.value[idx];
    row.messageCount = messageCount;
    row.userMessageCount = userMessageCount;
    if (!row.customTitle && (title !== '新会话' || row.title === '新会话')) row.title = title;
    if (bump) {
      row.updatedAt = now;
      sessionHistoryItems.value.splice(idx, 1);
      sessionHistoryItems.value.unshift(row);
    }
  } else {
    sessionHistoryItems.value.unshift({
      id,
      title,
      updatedAt: now,
      messageCount,
      userMessageCount,
    });
  }
  sessionHistoryItems.value = sessionHistoryItems.value.slice(0, 80);
  persistSessionHistoryList();
};

const mergeSessionHistoryFromServer = (serverItems) => {
  // 服务端权威：整表替换（保留当前 tab 内存里尚未落库的空会话占位）
  const currentId = conversationId.value;
  const currentLocal = currentId
    ? sessionHistoryItems.value.find((s) => s.id === currentId)
    : null;
  const next = (Array.isArray(serverItems) ? serverItems : [])
    .filter((x) => x && typeof x.id === 'string')
    .map((it) => ({
      id: String(it.id),
      title: String(it.title || '新会话'),
      updatedAt: String(it.updatedAt || new Date().toISOString()),
      messageCount: Number(it.messageCount) || 0,
      userMessageCount: Number(it.userMessageCount) || 0,
      customTitle: Boolean(it.customTitle),
    }));
  if (
    currentLocal &&
    currentId &&
    !next.some((s) => s.id === currentId) &&
    (Number(currentLocal.userMessageCount) || 0) > 0
  ) {
    next.unshift(currentLocal);
  }
  sessionHistoryItems.value = next.slice(0, 80);
};

const sessionFeedbackStorageKey = () => `rag_session_feedback:${conversationId.value || 'default'}`;

const feedbackUserIndexForMessage = (msg) => {
  if (typeof msg?.userMessageIndex === 'number' && msg.userMessageIndex >= 0) return msg.userMessageIndex;
  const tid = msg?.turnId;
  if (!tid) return null;
  const user = messages.value.find((x) => x.role === 'user' && x.turnId === tid);
  return typeof user?.userMessageIndex === 'number' ? user.userMessageIndex : null;
};

const parseFeedbackUserIndexFromItem = (item) => {
  if (typeof item?.userMessageIndex === 'number' && item.userMessageIndex >= 0) return item.userMessageIndex;
  const fbKey = String(item?.feedbackKey || '').trim();
  const um = /^umidx:(\d+)$/.exec(fbKey);
  if (um) return Number(um[1]);
  return null;
};

const persistSessionFeedback = () => {
  if (typeof window === 'undefined' || !conversationId.value) return;
  try {
    window.sessionStorage.setItem(
      sessionFeedbackStorageKey(),
      JSON.stringify({ scores: feedbackByUserIndex.value, acks: feedbackAckByUserIndex.value })
    );
  } catch {}
};

const restoreSessionFeedback = () => {
  if (typeof window === 'undefined' || !conversationId.value) {
    feedbackByUserIndex.value = {};
    feedbackAckByUserIndex.value = {};
    return;
  }
  try {
    const raw = window.sessionStorage.getItem(sessionFeedbackStorageKey());
    if (!raw) {
      feedbackByUserIndex.value = {};
      feedbackAckByUserIndex.value = {};
      return;
    }
    const parsed = JSON.parse(raw);
    feedbackByUserIndex.value = parsed?.scores && typeof parsed.scores === 'object' ? { ...parsed.scores } : {};
    feedbackAckByUserIndex.value = parsed?.acks && typeof parsed.acks === 'object' ? { ...parsed.acks } : {};
  } catch {
    feedbackByUserIndex.value = {};
    feedbackAckByUserIndex.value = {};
  }
};

const hydrateSessionFeedbackFromServer = async () => {
  const sid = conversationId.value;
  if (!sid) return;
  try {
    const res = await $fetch(`/api/rag/session-feedback?sessionId=${encodeURIComponent(sid)}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    if (!items.length) return;
    const scores = { ...feedbackByUserIndex.value };
    const acks = { ...feedbackAckByUserIndex.value };
    for (const item of items) {
      const uidx = parseFeedbackUserIndexFromItem(item);
      const score = Number(item.score);
      if (uidx == null || (score !== 1 && score !== -1)) continue;
      if (scores[uidx] === 1 || scores[uidx] === -1) continue;
      scores[uidx] = score;
      acks[uidx] =
        score === 1 ? '已标记为有帮助 · 感谢反馈（已同步）' : '已标记为不准确 · 感谢反馈（已同步）';
    }
    feedbackByUserIndex.value = scores;
    feedbackAckByUserIndex.value = acks;
    persistSessionFeedback();
    applyFeedbackToMessages();
  } catch {}
};

const applyFeedbackToMessages = () => {
  for (const msg of messages.value) {
    if (msg.role !== 'assistant') continue;
    const uidx = feedbackUserIndexForMessage(msg);
    if (uidx == null) continue;
    const score = feedbackByUserIndex.value[uidx];
    if (score === 1 || score === -1) msg.feedbackSent = true;
  }
};

const turnFeedbackSubmitted = (msg) => {
  const uidx = feedbackUserIndexForMessage(msg);
  if (uidx == null) return false;
  const score = feedbackByUserIndex.value[uidx];
  return score === 1 || score === -1;
};

const turnFeedbackAckText = (msg) => {
  const uidx = feedbackUserIndexForMessage(msg);
  const ack = uidx != null ? String(feedbackAckByUserIndex.value[uidx] || '').trim() : '';
  if (ack) return ack;
  const score = uidx != null ? feedbackByUserIndex.value[uidx] : undefined;
  if (score === 1) return '已标记为有帮助 · 感谢反馈';
  if (score === -1) return '已标记为不准确 · 感谢反馈';
  return '';
};

const applyTurnFeedback = (userIndex, score, ack) => {
  feedbackByUserIndex.value = { ...feedbackByUserIndex.value, [userIndex]: score };
  if (ack !== undefined) {
    feedbackAckByUserIndex.value = { ...feedbackAckByUserIndex.value, [userIndex]: ack };
  }
  for (const msg of messages.value) {
    if (msg.role === 'assistant' && feedbackUserIndexForMessage(msg) === userIndex) {
      msg.feedbackSent = true;
    }
  }
  persistSessionFeedback();
};

const clearFeedbackForUserIndex = (userIndex) => {
  const scores = { ...feedbackByUserIndex.value };
  const acks = { ...feedbackAckByUserIndex.value };
  delete scores[userIndex];
  delete acks[userIndex];
  feedbackByUserIndex.value = scores;
  feedbackAckByUserIndex.value = acks;
  persistSessionFeedback();
  for (const msg of messages.value) {
    if (msg.role === 'assistant' && feedbackUserIndexForMessage(msg) === userIndex) {
      msg.feedbackSent = false;
    }
  }
};

/** 撤回/编辑重发：清除该轮及之后 userMessageIndex 的反馈 */
const clearFeedbackFromTurn = (fromTurnId) => {
  if (!fromTurnId) return;
  const anchor = messages.value.find((m) => m.role === 'user' && m.turnId === fromTurnId);
  const fromIdx = anchor?.userMessageIndex;
  const scores = { ...feedbackByUserIndex.value };
  const acks = { ...feedbackAckByUserIndex.value };
  for (const msg of messages.value) {
    if (msg.role !== 'user' || typeof msg.userMessageIndex !== 'number') continue;
    const drop =
      typeof fromIdx === 'number'
        ? msg.userMessageIndex >= fromIdx
        : (msg.turnId ?? 0) >= fromTurnId;
    if (!drop) continue;
    delete scores[msg.userMessageIndex];
    delete acks[msg.userMessageIndex];
  }
  feedbackByUserIndex.value = scores;
  feedbackAckByUserIndex.value = acks;
  persistSessionFeedback();
  for (const msg of messages.value) {
    if (msg.role !== 'assistant') continue;
    const uidx = feedbackUserIndexForMessage(msg);
    if (uidx == null) continue;
    if (scores[uidx] === undefined) msg.feedbackSent = false;
  }
};

const clearFeedbackForTurnOnly = (turnId) => {
  const user = messages.value.find((m) => m.role === 'user' && m.turnId === turnId);
  if (typeof user?.userMessageIndex !== 'number') return;
  clearFeedbackForUserIndex(user.userMessageIndex);
};

const clearLocalSessionCaches = (id) => {
  if (typeof window === 'undefined' || !id) return;
  try {
    window.sessionStorage.removeItem(`rag_session_feedback:${id}`);
  } catch {}
};

const fetchServerSessionHistory = async () => {
  const uid = ensureRagUserId();
  try {
    const qs = new URLSearchParams({ userId: uid });
    const res = await fetch(`/api/rag/sessions?${qs.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    mergeSessionHistoryFromServer(items);
  } catch {}
};

const resetChatMessages = () => {
  messages.value = [{ ...DEFAULT_WELCOME }];
  turnSeq.value = 0;
  activeTurnId.value = 0;
  editingTurnId.value = null;
  editDraft.value = '';
};

const makeAssistantShell = (turnId, question) => ({
  role: 'assistant',
  turnId,
  content: '',
  intermediate_steps: [],
  processSteps: [],
  status: '正在思考…',
  turnStartedAt: Date.now(),
  evidenceBySource: {},
  retrievalMeta: null,
  agentSources: [],
  showEvidence: false,
  feedbackSent: false,
  questionForFeedback: question,
});

const formatElapsedMs = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const appendProcessStep = (msg, step) => {
  if (!msg) return;
  if (!Array.isArray(msg.processSteps)) msg.processSteps = [];
  const text = String(step?.text || '').trim();
  if (!text) return;
  const last = msg.processSteps[msg.processSteps.length - 1];
  if (last && last.kind === step.kind && last.text === text && !step.ms) return;
  msg.processSteps.push({
    kind: step.kind || 'status',
    text,
    name: step.name || '',
    phase: step.phase || '',
    ms: Number.isFinite(step.ms) ? step.ms : undefined,
    at: Date.now(),
  });
  if (step.kind === 'status' || step.kind === 'node' || step.kind === 'phase') {
    msg.status = text;
  }
};

const processSteps = (msg) => (Array.isArray(msg?.processSteps) ? msg.processSteps : []);

const stepDurationLabel = (msg, index) => {
  const steps = processSteps(msg);
  const step = steps[index];
  if (!step) return '';
  if (Number.isFinite(step.ms)) return `+${formatElapsedMs(step.ms)}`;
  if (index === 0 && msg.turnStartedAt && step.at) {
    return `+${formatElapsedMs(step.at - msg.turnStartedAt)}`;
  }
  const prev = steps[index - 1];
  if (prev?.at && step.at) return `+${formatElapsedMs(step.at - prev.at)}`;
  return '';
};

const processElapsedLabel = (msg) => {
  if (!processSteps(msg).length) return '';
  if (isTurnRunning(msg.turnId) && msg.turnStartedAt) {
    return formatElapsedMs(liveProcessMs.value);
  }
  const steps = processSteps(msg);
  const last = steps[steps.length - 1];
  const end = last?.at || Date.now();
  const start = msg.turnStartedAt || steps[0]?.at;
  if (!start) return '';
  return formatElapsedMs(end - start);
};

const isTurnRunning = (turnId) => isLoading.value && activeTurnId.value === turnId;

const isProcessExpanded = (msg) => {
  const tid = msg?.turnId;
  if (!tid || !processSteps(msg).length) return false;
  if (isTurnRunning(tid)) return true;
  return !collapsedProcessTurns.value.has(tid);
};

const toggleProcessPanel = (turnId) => {
  if (!turnId) return;
  const next = new Set(collapsedProcessTurns.value);
  if (next.has(turnId)) next.delete(turnId);
  else next.add(turnId);
  collapsedProcessTurns.value = next;
};

const showConfirmDialog = (message, title = '确认') =>
  new Promise((resolve) => {
    appModal.value = {
      open: true,
      mode: 'confirm',
      title,
      message,
      inputValue: '',
      inputPlaceholder: '',
      pendingAction: { type: 'resolve', resolve },
    };
  });

const showAlertDialog = (message, title = '提示') =>
  new Promise((resolve) => {
    appModal.value = {
      open: true,
      mode: 'alert',
      title,
      message,
      inputValue: '',
      inputPlaceholder: '',
      pendingAction: { type: 'resolve', resolve },
    };
  });

const stopGeneration = () => {
  if (chatAbortController) {
    chatAbortController.abort();
    chatAbortController = null;
  }
  isLoading.value = false;
  if (processTickTimer) {
    clearInterval(processTickTimer);
    processTickTimer = null;
  }
  const last = messages.value[messages.value.length - 1];
  if (last?.role === 'assistant') {
    appendProcessStep(last, { kind: 'status', text: '已停止生成' });
    last.status = '';
    if (!String(last.content || '').trim()) {
      last.content = '（已停止生成）';
    }
  }
  activeTurnId.value = 0;
};

const onSendOrCancel = () => {
  if (isLoading.value) {
    stopGeneration();
    return;
  }
  void sendMessage();
};

const onInputKeydown = (e) => {
  if (e.key === 'Escape' && isLoading.value) {
    e.preventDefault();
    stopGeneration();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !isLoading.value) {
    e.preventDefault();
    void sendMessage();
  }
};

const truncateLocalFromTurn = (turnId) => {
  const cutIdx = messages.value.findIndex((m) => m.role === 'user' && m.turnId === turnId);
  if (cutIdx < 0) return null;
  const userMsg = messages.value[cutIdx];
  messages.value = messages.value.slice(0, cutIdx);
  // turnSeq 单调递增，不在截断后回退，避免新轮次复用 turnId 继承旧反馈
  return userMsg;
};

const truncateForRegenerate = (turnId) => {
  const cutIdx = messages.value.findIndex((m) => m.role === 'user' && m.turnId === turnId);
  if (cutIdx < 0) return null;
  const userMsg = messages.value[cutIdx];
  messages.value = messages.value.slice(0, cutIdx + 1);
  return userMsg;
};

const copyMessageText = async (text, turnId) => {
  const t = String(text || '').trim();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    return;
  }
  if (copyAckTimer) clearTimeout(copyAckTimer);
  copyAckTurnId.value = turnId ?? null;
  copyAckTimer = setTimeout(() => {
    copyAckTurnId.value = null;
    copyAckTimer = null;
  }, 1600);
};

const syncTruncateToServer = async (fromUserIndex, opts = {}) => {
  if (!conversationId.value) return false;
  const fallback = String(opts.fallbackUserText || opts.replaceUserText || '').trim();
  const replace = String(opts.replaceUserText || '').trim();
  const hasIdx = typeof fromUserIndex === 'number' && fromUserIndex >= 0;
  if (!hasIdx && !fallback) return false;
  try {
    const res = await fetch('/api/rag/session-truncate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: conversationId.value,
        ...(hasIdx ? { fromUserIndex } : {}),
        fromTurnId: typeof opts.fromTurnId === 'number' ? opts.fromTurnId : undefined,
        userId: ensureRagUserId(),
        ...(replace ? { replaceUserText: replace } : {}),
        ...(fallback ? { fallbackUserText: fallback } : {}),
      }),
    });
    if (!res.ok) {
      console.warn('session truncate failed:', res.status);
      return false;
    }
    const data = await res.json().catch(() => null);
    return data?.ok !== false;
  } catch (e) {
    console.warn('session truncate failed:', e);
    return false;
  }
};

const withdrawTurn = async (turnId) => {
  if (isTurnRunning(turnId)) {
    await showAlertDialog('该轮正在生成中，请先点击「停止」再撤回。');
    return;
  }
  const okConfirm = await showConfirmDialog('撤回后将删除该轮及之后的对话（服务端同步更新），是否继续？', '撤回对话');
  if (!okConfirm) return;
  const userMsg = truncateLocalFromTurn(turnId);
  const synced = await syncTruncateToServer(
    typeof userMsg?.userMessageIndex === 'number' ? userMsg.userMessageIndex : null,
    { fallbackUserText: String(userMsg?.content || ''), fromTurnId: turnId }
  );
  if (!synced) {
    await showAlertDialog('本地已删除该轮，但服务端未能定位对应消息。请刷新会话后再试。');
  }
  const tid = turnId;
  if (tid) {
    clearFeedbackFromTurn(tid);
  }
  touchCurrentSessionHistory({ bump: false });
};

const startEditTurn = (msg) => {
  if (!msg?.turnId || isTurnRunning(msg.turnId)) return;
  editingTurnId.value = msg.turnId;
  editDraft.value = String(msg.content || '');
};

const cancelEditTurn = () => {
  editingTurnId.value = null;
  editDraft.value = '';
};

const submitEditResend = async (msg) => {
  const text = editDraft.value.trim();
  if (!text || !msg?.turnId) return;
  if (isTurnRunning(msg.turnId)) {
    await showAlertDialog('该轮正在生成中，请先停止。');
    return;
  }
  const fromIdx = msg.userMessageIndex;
  const fromTurnId = msg.turnId;
  const oldText = String(msg.content || '').trim();
  cancelEditTurn();
  truncateLocalFromTurn(fromTurnId);
  clearFeedbackFromTurn(fromTurnId);
  const synced = await syncTruncateToServer(typeof fromIdx === 'number' ? fromIdx : null, {
    fallbackUserText: oldText || text,
    fromTurnId,
  });
  if (!synced) {
    await showAlertDialog('服务端找不到对应用户消息，请重新发送新问题。');
    return;
  }
  await sendMessage(text);
};

const regenerateTurn = async (msg) => {
  if (!msg?.turnId || isLoading.value || isTurnRunning(msg.turnId)) return;
  if (editingTurnId.value === msg.turnId && editDraft.value.trim()) {
    await submitEditResend(msg);
    return;
  }
  const uidx = msg.userMessageIndex;
  cancelEditTurn();
  const userMsg = truncateForRegenerate(msg.turnId);
  const text = String(userMsg?.content || msg.content || '').trim();
  if (!text && typeof uidx !== 'number') {
    await showAlertDialog('无法定位该轮用户消息，请重新发送新问题。');
    return;
  }
  if (!text) return;
  clearFeedbackForTurnOnly(msg.turnId);
  const synced = await syncTruncateToServer(typeof uidx === 'number' ? uidx : null, {
    replaceUserText: text,
    fallbackUserText: text,
    fromTurnId: msg.turnId,
  });
  if (!synced) {
    await showAlertDialog('服务端找不到对应用户消息，请重新发送新问题。');
    return;
  }
  await sendMessage(text, { regenerateTurnId: msg.turnId });
};

const loadSessionFromServer = async (id) => {
  try {
    const res = await fetch(`/api/rag/session?sessionId=${encodeURIComponent(id)}`);
    if (!res.ok) {
      resetChatMessages();
      return;
    }
    const data = await res.json();
    const rows = Array.isArray(data?.messages) ? data.messages : [];
    if (!rows.length) {
      resetChatMessages();
      return;
    }
    messages.value = [{ ...DEFAULT_WELCOME }];
    let turnId = 0;
    let userIdx = 0;
    for (const m of rows) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content =
        role === 'assistant'
          ? sanitizeAssistantContent(String(m.content || ''))
          : String(m.content || '');
      if (!content.trim()) continue;
      if (role === 'user') {
        turnId += 1;
        messages.value.push({
          role: 'user',
          content,
          turnId,
          userMessageIndex: userIdx,
        });
        userIdx += 1;
      } else {
        messages.value.push({
          role: 'assistant',
          content,
          turnId,
          intermediate_steps: [],
          processSteps: [],
          status: '',
          evidenceBySource: {},
          retrievalMeta: null,
          agentSources: [],
          showEvidence: false,
          feedbackSent: false,
          questionForFeedback: '',
        });
      }
    }
    turnSeq.value = turnId;
    restoreSessionFeedback();
    applyFeedbackToMessages();
    await nextTick();
    scrollToBottom();
  } catch {
    resetChatMessages();
  }
};

const ensureConversationId = () => {
  if (conversationId.value) return conversationId.value;
  let id = readTabRagSessionId();
  if (!id) id = generateSessionId();
  conversationId.value = id;
  setTabRagSessionId(id);
  touchCurrentSessionHistory({ bump: false });
  return id;
};

const newSession = async (opts = {}) => {
  if (isLoading.value && !opts.skipConfirm) {
    appModal.value = {
      open: true,
      mode: 'confirm',
      title: '切换会话',
      message: '当前正在生成回答，确定要新建会话吗？',
      inputValue: '',
      inputPlaceholder: '',
      pendingAction: 'new_session',
    };
    return;
  }
  touchCurrentSessionHistory({ bump: false });
  const id = generateSessionId();
  conversationId.value = id;
  setTabRagSessionId(id);
  resetChatMessages();
  restoreSessionFeedback();
  touchCurrentSessionHistory({ bump: true });
  void fetchServerSessionHistory();
};

const switchSession = async (id) => {
  if (!id || id === conversationId.value) return;
  if (isLoading.value) {
    appModal.value = {
      open: true,
      mode: 'confirm',
      title: '切换会话',
      message: '当前正在生成回答，确定要切换会话吗？',
      inputValue: '',
      inputPlaceholder: '',
      pendingAction: { type: 'switch', id },
    };
    return;
  }
  sessionSwitching.value = true;
  try {
    touchCurrentSessionHistory({ bump: false });
    conversationId.value = id;
    setTabRagSessionId(id);
    restoreSessionFeedback();
    await loadSessionFromServer(id);
    await hydrateSessionFeedbackFromServer();
    touchCurrentSessionHistory({ bump: false });
  } finally {
    sessionSwitching.value = false;
  }
};

const renameSessionHistory = (item) => {
  appModal.value = {
    open: true,
    mode: 'prompt',
    title: '重命名会话',
    message: '',
    inputValue: item.title,
    inputPlaceholder: '输入会话标题',
    pendingAction: { type: 'rename', id: item.id },
  };
};

const deleteSessionHistory = (id) => {
  appModal.value = {
    open: true,
    mode: 'confirm',
    title: '删除会话',
    message: '确定删除该会话及其历史记录吗？此操作不可恢复。',
    inputValue: '',
    inputPlaceholder: '',
    pendingAction: { type: 'delete', id },
  };
};

const onAppModalConfirm = async (inputValue) => {
  const action = appModal.value.pendingAction;
  appModal.value.pendingAction = null;
  if (action?.type === 'resolve') {
    action.resolve(true);
    return;
  }
  if (action === 'new_session') {
    touchCurrentSessionHistory({ bump: false });
    const id = generateSessionId();
    conversationId.value = id;
    setTabRagSessionId(id);
    resetChatMessages();
    restoreSessionFeedback();
    touchCurrentSessionHistory({ bump: true });
    void fetchServerSessionHistory();
    return;
  }
  if (action?.type === 'switch') {
    await switchSession(action.id);
    return;
  }
  if (action?.type === 'rename') {
    const title = String(inputValue || '').trim();
    if (!title) return;
    try {
      await fetch('/api/rag/session-rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: action.id, title }),
      });
      const row = sessionHistoryItems.value.find((s) => s.id === action.id);
      if (row) {
        row.title = title;
        row.customTitle = true;
        persistSessionHistoryList();
      }
    } catch {}
    return;
  }
  if (action?.type === 'delete') {
    try {
      const res = await fetch('/api/rag/session-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sessionId: action.id, userId: ensureRagUserId() }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        openModal('删除失败', `HTTP ${res.status}${detail ? `：${detail}` : ''}`, 'error');
        return;
      }
    } catch (e) {
      openModal('删除失败', e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    sessionHistoryItems.value = sessionHistoryItems.value.filter((s) => s.id !== action.id);
    persistSessionHistoryList();
    clearLocalSessionCaches(action.id);
    if (conversationId.value === action.id) {
      conversationId.value = '';
      clearTabRagSessionId();
      const fallback = sessionHistoryItems.value[0]?.id;
      if (fallback) {
        await switchSession(fallback);
      } else {
        await newSession({ skipConfirm: true });
      }
    } else {
      void fetchServerSessionHistory();
    }
  }
};

const onAppModalCancel = () => {
  const action = appModal.value.pendingAction;
  if (action?.type === 'resolve') action.resolve(false);
  appModal.value.pendingAction = null;
};

const openModal = (title, message, type = 'success') => {
  modal.value = { show: true, title, message, type };
};

const escapeHtml = (raw = '') => raw
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const toSafeParagraphs = (text = '') => {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  return lines.map(line => `<p>${escapeHtml(line)}</p>`).join('');
};

const toSafeListOrParagraphs = (text = '') => {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  const bulletLike = lines.every(line => /^(\d+[\.\)]|[-*]|[一二三四五六七八九十]+[、.])\s*/.test(line));
  if (!bulletLike) return lines.map(line => `<p>${escapeHtml(line)}</p>`).join('');

  const items = lines.map(line => line.replace(/^(\d+[\.\)]|[-*]|[一二三四五六七八九十]+[、.])\s*/, '').trim());
  return `<ul class="list-disc pl-5 space-y-1">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
};

const toSourceChips = (text = '') => {
  const raw = String(text ?? '')
    .split(/[\n,，;；]/)
    .map(item => item.trim())
    .filter(Boolean);
  if (!raw.length) return '';
  return `<div class="rag-source-chips">${raw.map(item => `<button type="button" class="rag-source-chip" data-source-name="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')}</div>`;
};

const parseEvidenceBlocksFromText = (text = '') => {
  const blocks = [];
  const raw = String(text ?? '').replace(/\\n/g, '\n');
  const re = /\[内容\]\s*[：:]\s*([\s\S]*?)(?:\n\s*\[来源\]\s*[：:]\s*([^\n]+))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const content = String(m[1] ?? '').trim();
    const source = String(m[2] ?? '').trim() || 'unknown';
    if (content) blocks.push({ content, source });
  }
  return blocks;
};

const stripEvidenceBlocksFromText = (text = '') => {
  let s = String(text ?? '').replace(/\\n/g, '\n');
  s = s
    .replace(/\[内容\]\s*[：:]\s*[\s\S]*?(?:\n\s*\[来源\]\s*[：:]\s*[^\n]+)?/g, '')
    .replace(/^\s*\[来源\]\s*[：:]\s*[^\n]+/gm, '')
    .replace(/^\s*\[内容\]\s*[：:]\s*[^\n]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
};

const extractReferenceLine = (text = '') => {
  const src = String(text ?? '').replace(/\\n/g, '\n');
  const m = src.match(/(?:^|\n)\s*参考\s*[：:]\s*(.+?)\s*$/m);
  if (!m) return { text: src.trim(), refs: [] };
  const refs = m[1]
    .split(/[、,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const without = src.replace(/(?:^|\n)\s*参考\s*[：:]\s*.+?\s*$/m, '').trim();
  return { text: without, refs };
};

const extractAnswerBody = (content = '') => {
  const cleaned = sanitizeAssistantContent(content);
  const { text, refs } = extractReferenceLine(cleaned);
  return { text: text.trim(), refs };
};

const normalizeEvidenceText = (text = '') => {
  let s = String(text ?? '').trim().replace(/\\n/g, '\n');
  s = s.replace(/\[内容\]\s*[：:]\s*/g, '');
  s = s.replace(/\n\s*\[来源\]\s*[：:]\s*[^\n]+/g, '');
  s = s.replace(/^\s*\[来源\]\s*[：:]\s*[^\n]+/gm, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
};

const shortDocName = (name = '') => {
  const n = String(name || '').trim();
  if (n.length <= 28) return n;
  return `${n.slice(0, 24)}…`;
};

const formatEvidencePreview = (text = '', opts = {}) => {
  const compact = Boolean(opts?.compact);
  const cleaned = normalizeEvidenceText(text);
  if (!cleaned) return '';
  const maxLen = compact ? 120 : 280;
  const lines = cleaned.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const headingLine = lines.find((l) => /^#{1,4}\s+/.test(l) || /^第.+条/.test(l));
  const bodyLines = lines.filter((l) => l !== headingLine).slice(0, compact ? 2 : 4);
  const parts = [];
  if (headingLine) {
    const headingText = headingLine.replace(/^#{1,4}\s+/, '');
    parts.push(`<div class="ev-heading">${escapeHtml(headingText)}</div>`);
  }
  for (const line of bodyLines) {
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      parts.push(`<div class="ev-bullet"><span class="ev-bullet-dot">•</span>${escapeHtml(bullet[1])}</div>`);
      continue;
    }
    parts.push(`<p class="ev-line">${escapeHtml(line)}</p>`);
  }
  if (parts.length) return parts.join('');
  const preview = cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
  return `<p class="ev-line">${escapeHtml(preview)}</p>`;
};

const shortRerankLabel = (mode = '') => {
  const m = String(mode || '').trim();
  if (!m) return '';
  if (m.includes('embedding')) return '向量重排';
  if (m.includes('bm25')) return 'BM25';
  if (m.includes('lexical')) return '词法重排';
  return m.length > 10 ? `${m.slice(0, 8)}…` : m;
};

const toggleEvidence = (msg) => {
  if (!msg) return;
  msg.showEvidence = !msg.showEvidence;
};

const mergeEvidenceIntoMsg = (msg, rows = []) => {
  if (!msg || !Array.isArray(rows)) return;
  for (const snip of rows) {
    const content = String(snip?.content || '').trim();
    if (!content) continue;
    const key = String(snip?.source || 'unknown').trim() || 'unknown';
    if (!msg.evidenceBySource[key]) msg.evidenceBySource[key] = [];
    const dup = msg.evidenceBySource[key].some(
      (it) => String(it?.content || '').slice(0, 96) === content.slice(0, 96)
    );
    if (!dup) msg.evidenceBySource[key].push({ source: key, content });
  }
};

const sourceChipList = (msg) => {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const n = String(name || '').trim();
    if (!n || n === 'unknown' || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  const bySource = msg?.evidenceBySource;
  if (bySource && typeof bySource === 'object') {
    Object.keys(bySource).forEach(add);
  }
  extractAnswerBody(msg?.content || '').refs.forEach(add);
  (msg?.agentSources || []).forEach((s) => add(s?.ref));
  return out.slice(0, 6);
};

const evidenceCardList = (msg) => {
  const cards = [];
  const seen = new Set();
  const add = (content, source) => {
    const raw = String(content || '').trim();
    if (!raw) return;
    if (/\[内容\]|\[来源\]/.test(raw)) {
      const reparsed = parseEvidenceBlocksFromText(raw);
      if (reparsed.length) {
        reparsed.forEach((p) => add(p.content, p.source !== 'unknown' ? p.source : source));
        return;
      }
    }
    const c = normalizeEvidenceText(raw);
    const src = String(source || 'unknown').trim();
    if (!c || c.length < 6) return;
    const key = `${src}::${c.slice(0, 96)}`;
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({ content: c, source: src });
  };

  const bySource = msg?.evidenceBySource;
  if (bySource && typeof bySource === 'object') {
    for (const [source, items] of Object.entries(bySource)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const raw = String(item?.content || '').trim();
        if (!raw) continue;
        const parsed = parseEvidenceBlocksFromText(raw);
        if (parsed.length) {
          parsed.forEach((p) => add(p.content, p.source !== 'unknown' ? p.source : source));
        } else {
          add(raw, item?.source || source);
        }
      }
    }
  }

  if (!cards.length) {
    parseEvidenceBlocksFromText(msg?.content || '').forEach((p) => add(p.content, p.source));
  }

  return cards.slice(0, 5);
};

const handleSourceChipClick = async (sourceName, msg) => {
  const matchedDocName = resolveSourceDocName(sourceName);
  if (!matchedDocName) {
    openModal('未匹配到文档', `未在左侧文档列表中找到来源：${sourceName}`, 'error');
    return;
  }
  setHighlightedDoc(matchedDocName);
  await scrollDocIntoView(matchedDocName);
  openSourceDrawer(matchedDocName, sourceName, msg?.evidenceBySource);
};

const stripToolDebugLines = (text = '') => {
  const s = String(text ?? '');
  return s
    .replace(/\[evidence_json\][\s\S]*?(?=\n\n|\n\[|$)/g, '')
    .replace(/\[clarify_json\][\s\S]*$/g, '')
    .replace(/\[retrieval_meta\][\s\S]*$/g, '')
    .replace(/^\[路由解释\][\s\S]*?\n\n/gm, '')
    .trim();
};

const extractToolOutputText = (output) => {
  if (output == null) return '';
  if (typeof output === 'string') return output.trim();
  if (typeof output !== 'object') return String(output).trim();
  if (typeof output.content === 'string' && output.content.trim()) return output.content.trim();
  if (output.kwargs && typeof output.kwargs.content === 'string' && output.kwargs.content.trim()) {
    return String(output.kwargs.content).trim();
  }
  if (typeof output.output === 'string' && output.output.trim()) return output.output.trim();
  return '';
};

const isLangChainSerializedBlob = (text = '') => {
  const s = String(text ?? '');
  if (!s.includes('{')) return false;
  return /langchain_core/i.test(s) || /"type"\s*:\s*"constructor"/.test(s) || /"ToolMessage"/.test(s);
};

const stripLangChainJsonBlobs = (text = '') => {
  let s = String(text ?? '');
  if (!isLangChainSerializedBlob(s)) return s.trim();
  s = s.replace(/```(?:json)?\s*[\s\S]*?```/gi, (block) => (isLangChainSerializedBlob(block) ? '' : block));
  s = s.replace(/\{[\s\S]*?"id"\s*:\s*\[[^\]]*langchain_core[^\]]*\][\s\S]*?\}(?:\s*$)?/gi, '');
  return s.trim();
};

const sanitizeAssistantContent = (text = '') => {
  let s = stripLangChainJsonBlobs(stripEvidenceBlocksFromText(stripToolDebugLines(text)));
  s = s.replace(/\[evidence_json\][\s\S]*?(?=\n\n|\n\[|$)/g, '');
  if (isLangChainSerializedBlob(s)) return '';
  return s.trim();
};

const isUnsafeStreamToken = (text = '') => {
  const s = String(text ?? '');
  if (!s.trim()) return true;
  if (isLangChainSerializedBlob(s)) return true;
  if (/^\s*[\[{]/.test(s) && /"kwargs"|langchain_core|"evidence"\s*:/.test(s)) return true;
  return false;
};

const stripCodeFences = (text = '') => {
  const s = String(text ?? '');
  return s.replace(/```(?:echarts|json|javascript|js)?\s*([\s\S]*?)```/gi, (block, inner) => {
    if (isLangChainSerializedBlob(inner) || /\[evidence_json\]/.test(inner)) return '';
    return inner;
  });
};

const stripHtmlTables = (html = '') => html.replace(/<table>/g, '<div class="table-scroll my-3 overflow-x-auto rounded-2xl border border-white/10"><table class="min-w-full divide-y divide-white/10">').replace(/<\/table>/g, '</table></div>');

const parseRetrievalMeta = (toolOutput) => {
  const raw = extractToolOutputText(toolOutput);
  const m = raw.match(/\[retrieval_meta\]\s*(\{[\s\S]*\})\s*$/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

const pct = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Math.round(Number(v) * 100)}%`;
};

const abSignificanceHint = computed(() => {
  const ab = intel.value.abSignificance;
  if (!ab) return '样本不足';
  const need = ab.minSamples ?? 20;
  if ((ab.treatmentN ?? 0) < need || (ab.controlN ?? 0) < need) {
    return `样本 ${ab.treatmentN ?? 0}/${ab.controlN ?? 0}`;
  }
  return `Δ ${Math.round((ab.delta ?? 0) * 100)}%`;
});

const topBanditArm = computed(() => {
  const arms = intel.value.retrievalBandit?.arms ?? [];
  if (!arms.length) return '—';
  const best = [...arms].sort((a, b) => (b.estimatedOkRate ?? 0) - (a.estimatedOkRate ?? 0))[0];
  return best ? `${best.arm} ${Math.round((best.estimatedOkRate ?? 0) * 100)}%` : '—';
});

const refreshIntel = async () => {
  try {
    const res = await $fetch('/api/learning');
    intel.value = {
      learning: res?.learning ?? { total: 0, okRate: null },
      experience: res?.experience ?? { count: 0 },
      promptEvolution: res?.promptEvolution ?? { patchCount: 0, evolvedHintCount: 0, promotableCount: 0 },
      promptAb: res?.promptAb ?? { enabled: false, treatmentPercent: 50 },
      crossAgent: res?.crossAgent ?? { enabled: false, linkedUsers: 0 },
      localRerank: res?.localRerank ?? { enabled: false },
      embeddingRerank: res?.embeddingRerank ?? { enabled: false },
      onnxRerank: res?.onnxRerank ?? { enabled: false, sessionReady: false },
      sharedIdentity: res?.sharedIdentity ?? { enabled: false, mappedSessions: 0 },
      abSignificance: res?.abSignificance ?? { significant: false, treatmentN: 0, controlN: 0 },
      autoCurator: res?.autoCurator ?? { enabled: false },
      retrievalBandit: res?.retrievalBandit ?? { enabled: false, arms: [] },
      dedicatedRerank: res?.dedicatedRerank ?? { enabled: false, urlConfigured: false },
      oidc: res?.oidc ?? { enabled: false },
      evalBaseline: res?.evalBaseline ?? null,
    };
  } catch (e) {
    console.warn('refreshIntel failed:', e);
  }
};

const runCurate = async () => {
  intelCurating.value = true;
  try {
    const res = await $fetch('/api/learning/curate', { method: 'POST', body: { autoPromote: true } });
    const n = res?.report?.promotedHints?.length ?? 0;
    await refreshIntel();
    if (n > 0) openModal('整理完成', `已晋级 ${n} 条进化提示`, 'success');
  } catch (e) {
    console.warn('curate failed:', e);
    openModal('整理失败', '请确认服务在线后重试', 'error');
  } finally {
    intelCurating.value = false;
  }
};

const resetLearning = async (scope) => {
  if (!confirm('确定清空学习数据？此操作不可恢复。')) return;
  intelResetting.value = true;
  try {
    await $fetch('/api/learning/reset', { method: 'POST', body: { scope } });
    await refreshIntel();
  } catch (e) {
    console.warn('reset failed:', e);
  } finally {
    intelResetting.value = false;
  }
};

const sendFeedback = async (msg, index, score) => {
  if (turnFeedbackSubmitted(msg)) return;
  const turnId = msg?.turnId;
  if (!turnId) return;
  const uidx = feedbackUserIndexForMessage(msg);
  if (uidx == null) return;
  const userMsg = messages.value[index - 1];
  const question = userMsg?.role === 'user' ? String(userMsg.content || '').trim() : '';
  if (!question) return;
  const sources = msg.evidenceBySource ? Object.keys(msg.evidenceBySource).slice(0, 3).join('、') : '';
  feedbackSendingUserIndex.value = uidx;
  applyTurnFeedback(uidx, score, '提交中…');
  try {
    await $fetch('/api/feedback', {
      method: 'POST',
      body: {
        question,
        score,
        path: 'document_query',
        comment: sources ? `来源：${sources}` : undefined,
        source: sources ? sources.split('、')[0] : undefined,
        sessionId: conversationId.value || undefined,
        turnId,
        userMessageIndex: uidx,
      },
    });
    applyTurnFeedback(
      uidx,
      score,
      score === 1 ? '已标记为有帮助 · 感谢反馈（已用于检索学习）' : '已标记为不准确 · 感谢反馈（已用于检索学习）'
    );
    await refreshIntel();
  } catch (e) {
    console.warn('feedback failed:', e);
    applyTurnFeedback(uidx, score, '反馈提交失败，请重试');
  } finally {
    feedbackSendingUserIndex.value = null;
  }
};

const parseEvidenceSnippetsFromToolOutput = (toolOutput) => {
  const extracted = extractToolOutputText(toolOutput);
  if (!extracted) return [];

  const jsonMatch = extracted.match(/\[evidence_json\]\s*([\s\S]*?)(?:\n\[|$)/);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      const items = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
      const fromJson = items
        .map((it) => ({
          content: String(it?.content ?? it?.quote ?? '').trim(),
          source: String(it?.source ?? 'unknown').trim() || 'unknown',
        }))
        .filter((it) => it.content);
      if (fromJson.length) return fromJson.slice(0, 8);
    } catch {
      /* fall through */
    }
  }

  const raw = stripToolDebugLines(extracted);
  if (!raw) return [];

  const parsed = parseEvidenceBlocksFromText(raw);
  if (parsed.length) return parsed.slice(0, 8);
  const blocks = raw.split(/\n{2,}/g).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const b of blocks) {
    const nested = parseEvidenceBlocksFromText(b);
    if (nested.length) {
      out.push(...nested);
      continue;
    }
    const m = b.match(/\[内容\]:\s*([\s\S]*?)(?:\n\[来源\]:\s*([\s\S]*))?$/);
    if (m) {
      const content = String(m[1] ?? '').trim();
      const source = String(m[2] ?? '').trim() || 'unknown';
      if (content) out.push({ content, source });
      continue;
    }
    if (b.length >= 12 && b.length <= 480) out.push({ content: b, source: 'unknown' });
  }
  return out;
};

const sanitizeDomId = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const normalizeName = (name = '') => String(name).trim().toLowerCase();

const resolveSourceDocName = (sourceName = '') => {
  const normalized = normalizeName(sourceName);
  if (!normalized) return '';

  const exact = documents.value.find(doc => normalizeName(doc.name) === normalized);
  if (exact) return exact.name;

  const contains = documents.value.find(doc => normalizeName(doc.name).includes(normalized) || normalized.includes(normalizeName(doc.name)));
  return contains?.name || '';
};

const scrollDocIntoView = async (docName) => {
  await nextTick();
  const id = `doc-item-${sanitizeDomId(docName)}`;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

const setHighlightedDoc = (docName) => {
  highlightedDocName.value = docName;
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  // 高亮短暂停留，帮助用户快速定位来源文档
  highlightTimer = setTimeout(() => {
    highlightedDocName.value = '';
    highlightTimer = null;
  }, 3000);
};

const openSourceDrawer = (docName, sourceName, evidenceBySource) => {
  const doc = documents.value.find(item => item.name === docName);
  const summary = doc?.summary?.trim() || '';
  const type = doc?.type || '';
  const normalized = normalizeName(sourceName);
  const candidates = [];
  if (evidenceBySource && typeof evidenceBySource === 'object') {
    for (const [k, v] of Object.entries(evidenceBySource)) {
      if (!Array.isArray(v)) continue;
      // key 是按“来源label”聚合的（可能含 #p）
      if (normalizeName(k).includes(normalized) || normalized.includes(normalizeName(k))) {
        candidates.push(...v);
      }
    }
  }
  // 再兜底：若没按 sourceName 命中，尝试用 docName 匹配
  const docNameNorm = normalizeName(docName);
  if (candidates.length === 0 && evidenceBySource && typeof evidenceBySource === 'object') {
    for (const [k, v] of Object.entries(evidenceBySource)) {
      if (!Array.isArray(v)) continue;
      if (normalizeName(k).includes(docNameNorm)) {
        candidates.push(...v);
      }
    }
  }
  sourceDrawer.value = {
    show: true,
    docName,
    sourceName,
    summary,
    type,
    snippets: candidates.slice(0, 12)
  };
};

const handleFormattedAnswerClick = async (event, msg) => {
  const target = event?.target;
  if (!(target instanceof HTMLElement)) return;
  const sourceBtn = target.closest('[data-source-name]');
  if (!sourceBtn) return;

  const sourceName = sourceBtn.getAttribute('data-source-name') || '';
  const matchedDocName = resolveSourceDocName(sourceName);
  if (!matchedDocName) {
    openModal('未匹配到文档', `未在左侧文档列表中找到来源：${sourceName}`, 'error');
    return;
  }

  setHighlightedDoc(matchedDocName);
  await scrollDocIntoView(matchedDocName);
  openSourceDrawer(matchedDocName, sourceName, msg?.evidenceBySource);
};

const extractSection = (text, label) => {
  const sectionRegex = new RegExp(`${label}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n\\s*(问题|结论|依据|来源|补充说明)\\s*[：:]|$)`);
  const match = text.match(sectionRegex);
  return match?.[1]?.trim() || '';
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

const chartState = reactive({ instances: new Map() });

const extractJsonLikeBlock = (text = '') => {
  const src = String(text || '').trim();
  const fenced = src.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const direct = src.match(/\{[\s\S]*\}$/);
  return direct?.[0]?.trim() || '';
};

const tryParseEchartsOption = (text = '') => {
  const raw = extractJsonLikeBlock(text);
  if (!raw) return null;
  try {
    const normalized = raw
      .replace(/\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === 'object' && (parsed.series || parsed.xAxis || parsed.yAxis || parsed.legend || parsed.dataset)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
};

const markdownToHtml = (text = '') => md.render(String(text || '').trim());

const renderMessageTables = (html = '') => stripHtmlTables(html);

const renderChartContainers = (html, msgIndex) => {
  let chartIndex = 0;
  return html.replace(/<pre><code class="language-echarts">([\s\S]*?)<\/code><\/pre>/gi, (_, raw) => {
    const payload = escapeHtml(raw.trim());
    const id = `echarts-${msgIndex}-${chartIndex++}`;
    return `<div class="echarts-shell my-3 rounded-2xl border border-sky-400/20 bg-slate-950/70 p-3 shadow-lg shadow-black/20"><div id="${id}" class="echarts-canvas h-72 w-full" data-echarts-option="${payload}"></div></div>`;
  });
};



const normalizeAssistantMarkdown = (content = '') =>
  extractAnswerBody(content).text;

const formatAssistantMessage = (msg, msgIndex = 0) => formatAssistantContent(msg?.content || '', msgIndex);

const formatAssistantContent = (content = '', msgIndex = 0) => {
  const { text: answerBody } = extractAnswerBody(content);
  if (!answerBody?.trim()) {
    return '<p class="text-slate-300/70">（暂无内容）</p>';
  }
  if (/<RAG_NEEDS_CLARIFY>/i.test(answerBody)) {
    const clarifyText = answerBody.replace(/<RAG_NEEDS_CLARIFY>/gi, '').replace(/\[clarify_json\][\s\S]*$/g, '').trim();
    return `<div class="rag-answer-body">${renderMessageTables(markdownToHtml(clarifyText))}</div>`;
  }
  const html = renderChartContainers(
    renderMessageTables(markdownToHtml(stripCodeFences(answerBody))),
    msgIndex
  );
  return `<div class="rag-answer-body">${html}</div>`;
};

const mountEchartsInMessage = (msgIndex) => {
  if (typeof window === 'undefined') return;
  nextTick(() => {
    const root = document.querySelector(`.assistant-render[data-msg-index="${msgIndex}"]`);
    if (!root) return;
    const nodes = root.querySelectorAll('[data-echarts-option]');
    nodes.forEach((node) => {
      const optionText = node.getAttribute('data-echarts-option') || '';
      const option = tryParseEchartsOption(optionText);
      if (!option) return;
      let instance = chartState.instances.get(node.id);
      if (!instance) {
        instance = echarts.init(node, null, { renderer: 'canvas' });
        chartState.instances.set(node.id, instance);
      }
      instance.setOption(option, true);
      instance.resize();
    });
  });
};

const disposeChartByIndex = (msgIndex) => {
  const keyPrefix = `echarts-${msgIndex}-`;
  for (const [key, instance] of chartState.instances.entries()) {
    if (key.startsWith(keyPrefix)) {
      instance.dispose();
      chartState.instances.delete(key);
    }
  }
};

const fetchDocuments = async () => {
  try {
    const res = await $fetch('/api/list', {
      query: { t: Date.now() }
    });
    documents.value = res?.documents ?? [];
  } catch (error) {
    console.error('Failed to fetch documents:', error);
  }
};

const confirmDelete = async (fileName) => {
  if (confirm(`确定要从向量数据库中删除文档 "${fileName}" 吗？`)) {
    const previous = documents.value;
    documents.value = documents.value.filter(d => d.name !== fileName);
    try {
      const res = await $fetch('/api/delete', {
        method: 'POST',
        body: { fileName }
      });
      if (!res?.success) throw new Error(res?.message || 'Delete failed');
      fetchDocuments();
      openModal('删除成功', `已删除文档：${fileName}\n当前文档数：${documents.value.length}`, 'success');
    } catch (err) {
      console.error('Delete failed:', err);
      documents.value = previous;
      openModal('删除失败', '删除操作失败，请查看控制台日志。', 'error');
    }
  }
};

const getDocColor = (type) => {
  switch (type) {
    case 'pdf': return 'bg-red-400';
    case 'doc':
    case 'docx': return 'bg-blue-400';
    case 'zip': return 'bg-yellow-400';
    case 'md': return 'bg-green-400';
    case 'csv': return 'bg-teal-400';
    case 'json': return 'bg-orange-400';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'bmp':
    case 'tiff':
    case 'gif':
    case 'webp': return 'bg-indigo-400';
    default: return 'bg-gray-400';
  }
};

const triggerUpload = () => {
  fileInput.value.click();
};

const handleFileUpload = async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  isUploading.value = true;
  const formData = new FormData();
  formData.append('file', file);

  try {
    const data = await $fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    const uploadedName = data?.fileName || file.name;
    const uploadedType = (uploadedName.split('.').pop() || '').toLowerCase() || 'unknown';
    if (!documents.value.find(d => d.name === uploadedName)) {
      documents.value = [{ name: uploadedName, summary: '处理中...', type: uploadedType }, ...documents.value];
    }
    await fetchDocuments();
    openModal('上传成功', `已处理文档：${uploadedName}\n当前文档数：${documents.value.length}`, 'success');
  } catch (error) {
    console.error('Upload failed:', error);
    openModal('上传失败', '文件上传失败，请检查控制台日志。', 'error');
  } finally {
    isUploading.value = false;
    event.target.value = '';
  }
};

const sendMessage = async (overrideText, opts = {}) => {
  const regenerateTurnId = opts.regenerateTurnId;
  const message = String(overrideText ?? userInput.value ?? '').trim();
  if (!message || isLoading.value) return;

  closeSourceDrawer();
  cancelEditTurn();

  let turnId;
  if (typeof regenerateTurnId === 'number') {
    turnId = regenerateTurnId;
  } else {
    userInput.value = '';
    turnId = turnSeq.value + 1;
    turnSeq.value = turnId;
    const userMessageIndex = messages.value.filter((m) => m.role === 'user').length;
    messages.value.push({ role: 'user', content: message, turnId, userMessageIndex });
  }

  if (typeof regenerateTurnId === 'number') {
    clearFeedbackForTurnOnly(turnId);
  } else {
    clearFeedbackFromTurn(turnId);
  }
  activeTurnId.value = turnId;

  isLoading.value = true;
  chatAbortController = new AbortController();
  await scrollToBottom();

  const assistantMsg = makeAssistantShell(turnId, message);
  appendProcessStep(assistantMsg, { kind: 'phase', phase: 'connect', text: '正在连接服务端…' });
  messages.value.push(assistantMsg);

  liveProcessMs.value = 0;
  if (processTickTimer) clearInterval(processTickTimer);
  processTickTimer = setInterval(() => {
    if (assistantMsg.turnStartedAt) {
      liveProcessMs.value = Date.now() - assistantMsg.turnStartedAt;
    }
  }, 200);

  try {
    ensureConversationId();
    const history = messages.value
      .filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && typeof m.content === 'string')
      .map(m => ({
        role: m.role,
        content: m.role === 'assistant' ? sanitizeAssistantContent(m.content) : m.content,
      }))
      .filter(m => m.content?.trim())
      .slice(0, -1)
      .slice(-12);

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: chatAbortController.signal,
      body: JSON.stringify({
        message,
        history,
        conversationId: conversationId.value || undefined,
        userId: ensureRagUserId(),
      }),
    });

    if (!response.ok) throw new Error('网络请求失败');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.replace('data: ', '');
        try {
          const data = JSON.parse(dataStr);
          
          if (data.type === 'token') {
            if (!isUnsafeStreamToken(data.content)) {
              assistantMsg.content += data.content;
            }
            assistantMsg.status = '';
            await nextTick();
            mountEchartsInMessage(messages.value.length - 1);
          } else if (data.type === 'phase') {
            appendProcessStep(assistantMsg, {
              kind: 'phase',
              phase: data.phase,
              text: data.content,
              ms: data.ms,
            });
          } else if (data.type === 'status' || data.type === 'node') {
            appendProcessStep(assistantMsg, {
              kind: data.type === 'node' ? 'node' : 'status',
              text: data.content,
            });
          } else if (data.type === 'tool_output') {
            const toolText = extractToolOutputText(data.output);
            assistantMsg.intermediate_steps.push({ 
              name: data.name, 
              output: toolText 
            });
            const meta = data.name === 'document_query' ? parseRetrievalMeta(toolText) : null;
            const toolLabel =
              data.name === 'document_query'
                ? meta?.evidenceCount
                  ? `文档检索完成（${meta.evidenceCount} 条${meta.rerankMode ? `，${meta.rerankMode}` : ''}${meta.ms ? `，${formatElapsedMs(meta.ms)}` : ''}）`
                  : '文档检索完成'
                : `工具 ${data.name} 返回结果`;
            appendProcessStep(assistantMsg, {
              kind: 'tool',
              text: toolLabel,
              name: data.name,
              ms: meta?.ms,
            });
            if (data.name === 'document_query') {
              if (meta) assistantMsg.retrievalMeta = meta;
              mergeEvidenceIntoMsg(assistantMsg, parseEvidenceSnippetsFromToolOutput(toolText));
            }
          } else if (data.type === 'agentResult') {
            const ar = data.agentResult;
            if (Array.isArray(ar?.sources)) {
              assistantMsg.agentSources = ar.sources.filter((s) => s?.ref);
            }
            if (Array.isArray(data.evidence) && data.evidence.length) {
              mergeEvidenceIntoMsg(assistantMsg, data.evidence);
            }
          } else if (data.type === 'aborted') {
            appendProcessStep(assistantMsg, { kind: 'status', text: '已停止生成' });
          } else if (data.type === 'done') {
            if (data.conversationId && typeof data.conversationId === 'string') {
              conversationId.value = data.conversationId;
              setTabRagSessionId(data.conversationId);
            }
            const doneAnswer = sanitizeAssistantContent(String(data.answer || '').trim());
            const streamed = sanitizeAssistantContent(String(assistantMsg.content || '').trim());
            assistantMsg.content = doneAnswer || streamed;
            assistantMsg.status = '';
            {
              const lastStep = processSteps(assistantMsg).slice(-1)[0];
              const hasDoneStep =
                lastStep && (lastStep.phase === 'done' || String(lastStep.text || '').includes('回答完成'));
              if (!hasDoneStep) {
                if (data.ms) {
                  appendProcessStep(assistantMsg, {
                    kind: 'phase',
                    phase: 'done',
                    text: `回答完成（总耗时 ${formatElapsedMs(data.ms)}）`,
                    ms: data.ms,
                  });
                } else {
                  appendProcessStep(assistantMsg, { kind: 'status', text: '回答完成' });
                }
              }
            }
            await nextTick();
            mountEchartsInMessage(messages.value.length - 1);
          } else if (data.type === 'error') {
            assistantMsg.content = `[错误]: ${data.content}`;
            appendProcessStep(assistantMsg, { kind: 'status', text: `错误：${data.content}` });
          }
          
          await scrollToBottom();
        } catch (e) {
          console.warn('解析 SSE 数据失败:', e);
        }
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      appendProcessStep(assistantMsg, { kind: 'status', text: '已停止生成' });
      if (!String(assistantMsg.content || '').trim()) {
        assistantMsg.content = '（已停止生成）';
      }
    } else {
      console.error('Chat failed:', error);
      assistantMsg.content = '抱歉，处理您的请求时出错了。';
      appendProcessStep(assistantMsg, { kind: 'status', text: '请求失败' });
    }
  } finally {
    isLoading.value = false;
    activeTurnId.value = 0;
    chatAbortController = null;
    if (processTickTimer) {
      clearInterval(processTickTimer);
      processTickTimer = null;
    }
    assistantMsg.status = '';
    assistantMsg.content = sanitizeAssistantContent(String(assistantMsg.content || '').trim());
    if (!String(assistantMsg.content || '').trim()) {
      assistantMsg.content = '未能生成有效回答，请换一种问法或指定左侧文档名称后重试。';
    }
    touchCurrentSessionHistory({ bump: true });
    void fetchServerSessionHistory();
    await scrollToBottom();
  }
};

const scrollToBottom = async () => {
  await nextTick();
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
  }
};

const createGalaxy = () => {
  const disposeMaterial = (material) => {
    if (!material) return;
    if (Array.isArray(material)) {
      for (const m of material) disposeMaterial(m);
      return;
    }
    if (material.map) material.map.dispose();
    material.dispose();
  };

  const disposeObjectDeep = (object) => {
    if (!object) return;
    object.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) disposeMaterial(child.material);
    });
  };

  const disposePoints = (points) => {
    if (!points) return;
    scene.remove(points);
    disposeObjectDeep(points);
    if (points.geometry) points.geometry.dispose();
    if (points.material) points.material.dispose();
  };

  const disposeSprite = (sprite) => {
    if (!sprite) return;
    scene.remove(sprite);
    if (sprite.material) disposeMaterial(sprite.material);
  };

  const disposeNebulas = () => {
    if (!nebulaSprites.length) return;
    for (const sprite of nebulaSprites) {
      if (!sprite) continue;
      if (sprite.parent) sprite.parent.remove(sprite);
      if (sprite.material) disposeMaterial(sprite.material);
    }
    nebulaSprites = [];
    if (nebulaSharedTexture) {
      nebulaSharedTexture.dispose();
      nebulaSharedTexture = null;
    }
  };

  disposePoints(galaxyPoints);
  disposePoints(backgroundPoints);
  disposeSprite(coreSprite);
  disposeNebulas();
  galaxyPoints = null;
  backgroundPoints = null;
  coreSprite = null;

  const randomNormal = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };

  const makeRadialTexture = () => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255, 245, 220, 1)');
    g.addColorStop(0.35, 'rgba(170, 220, 255, 0.55)');
    g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  };

  const makeSoftAlphaTexture = () => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(255, 255, 255, 0.95)');
    g.addColorStop(0.18, 'rgba(255, 255, 255, 0.65)');
    g.addColorStop(0.55, 'rgba(255, 255, 255, 0.18)');
    g.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  };

  const vertexShader = `
    attribute float size;
    attribute float alpha;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vColor = color;
      vAlpha = alpha;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      float dist = max(0.001, -mvPosition.z);
      gl_PointSize = size * (520.0 / dist);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 uv = gl_PointCoord - vec2(0.5);
      float d = length(uv);
      float a = smoothstep(0.5, 0.0, d);
      a = pow(a, 2.2);
      gl_FragColor = vec4(vColor, a * vAlpha);
    }
  `;

  const galaxyRadius = 1350;
  const arms = 4;
  const twist = 0.014;
  const armSpread = 0.36;
  const diskThickness = 42;
  const bulgeRadius = 260;
  const armTightness = 0.22;
  const dustLaneOffset = -0.18;
  const dustLaneWidth = 0.13;

  const galaxyCount = 26000;
  const galaxyGeometry = new THREE.BufferGeometry();
  const gPositions = new Float32Array(galaxyCount * 3);
  const gColors = new Float32Array(galaxyCount * 3);
  const gSizes = new Float32Array(galaxyCount);
  const gAlphas = new Float32Array(galaxyCount);

  const innerColor = new THREE.Color('#ffd0a6');
  const outerColor = new THREE.Color('#9ad6ff');
  const tempColor = new THREE.Color();
  const warmStar = new THREE.Color('#ffb788');
  const coolStar = new THREE.Color('#9ad6ff');
  const neutralStar = new THREE.Color('#ffffff');
  const redGiant = new THREE.Color('#ff6b6b');
  const armTints = [
    new THREE.Color('#7dd3fc'),
    new THREE.Color('#22d3ee'),
    new THREE.Color('#c084fc'),
    new THREE.Color('#fb7185')
  ];

  for (let i = 0; i < galaxyCount; i++) {
    const isBulge = Math.random() < 0.24;
    const radiusBase = isBulge ? bulgeRadius : galaxyRadius;
    const radiusPow = isBulge ? 0.55 : 1.85;
    const radius = Math.pow(Math.random(), radiusPow) * radiusBase;
    const armIndex = Math.floor(Math.random() * arms);
    const baseAngle = (armIndex / arms) * Math.PI * 2.0;
    const spiralAngle = radius * twist;
    const angleJitter = randomNormal() * armSpread * (0.35 + 0.65 * (1.0 - radius / galaxyRadius));
    const angle = baseAngle + spiralAngle + angleJitter;

    const armDensity = Math.exp(-0.5 * Math.pow(angleJitter / armTightness, 2));
    const lane = Math.exp(-0.5 * Math.pow((angleJitter - dustLaneOffset) / dustLaneWidth, 2));
    const laneFactor = 1.0 - 0.65 * lane * (0.25 + 0.75 * (1.0 - radius / galaxyRadius));

    const localNoise = randomNormal() * (radius * 0.014);
    const x = Math.cos(angle) * radius + localNoise;
    const z = Math.sin(angle) * radius + randomNormal() * (radius * 0.014);
    const thickness = diskThickness * (isBulge ? 0.75 : 1.0) * (0.25 + 0.75 * (1.0 - radius / galaxyRadius));
    const y = randomNormal() * thickness;

    gPositions[i * 3] = x;
    gPositions[i * 3 + 1] = y;
    gPositions[i * 3 + 2] = z;

    const t = Math.min(1, radius / galaxyRadius);
    tempColor.copy(innerColor).lerp(outerColor, t * t);
    const hueShift = (Math.random() - 0.5) * 0.08;
    const hsl = { h: 0, s: 0, l: 0 };
    tempColor.getHSL(hsl);
    tempColor.setHSL(hsl.h + hueShift, Math.min(1, hsl.s * (0.8 + Math.random() * 0.5)), Math.min(1, hsl.l * (0.92 + Math.random() * 0.22)));

    const tempPick = Math.random();
    let starTemp = neutralStar;
    if (tempPick < 0.12) starTemp = redGiant;
    else if (tempPick < 0.32) starTemp = warmStar;
    else if (tempPick < 0.58) starTemp = neutralStar;
    else starTemp = coolStar;

    const tempMix = isBulge ? 0.12 : 0.35;
    tempColor.lerp(starTemp, tempMix);

    if (!isBulge) {
      const armTint = armTints[armIndex % armTints.length];
      const armMix = Math.min(0.55, armDensity * (0.18 + 0.55 * (1.0 - t)));
      tempColor.lerp(armTint, armMix);
    }

    const intensity = (isBulge ? 0.95 : (0.65 + 0.35 * armDensity)) * laneFactor;
    tempColor.multiplyScalar(intensity);

    gColors[i * 3] = tempColor.r;
    gColors[i * 3 + 1] = tempColor.g;
    gColors[i * 3 + 2] = tempColor.b;

    const sizeBase = isBulge ? 8.5 : 4.2;
    const sparkle = 1.0 + Math.pow(Math.random(), 10) * 3.5;
    const size = (sizeBase + Math.random() * (isBulge ? 6.0 : 5.0)) * (1.05 - 0.45 * t) * sparkle;
    gSizes[i] = size;

    const alphaBase = isBulge ? 0.82 : 0.74;
    const alpha = alphaBase * (0.6 + 0.4 * armDensity) * laneFactor * (0.75 + Math.random() * 0.25);
    gAlphas[i] = Math.min(1.0, Math.max(0.05, alpha));
  }

  galaxyGeometry.setAttribute('position', new THREE.BufferAttribute(gPositions, 3));
  galaxyGeometry.setAttribute('color', new THREE.BufferAttribute(gColors, 3));
  galaxyGeometry.setAttribute('size', new THREE.BufferAttribute(gSizes, 1));
  galaxyGeometry.setAttribute('alpha', new THREE.BufferAttribute(gAlphas, 1));

  const galaxyMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true
  });

  galaxyPoints = new THREE.Points(galaxyGeometry, galaxyMaterial);
  galaxyPoints.rotation.x = Math.PI / 2;
  galaxyPoints.rotation.z = 0.25;
  scene.add(galaxyPoints);

  const dustCount = 18000;
  const dustGeometry = new THREE.BufferGeometry();
  const dPositions = new Float32Array(dustCount * 3);
  const dColors = new Float32Array(dustCount * 3);
  const dSizes = new Float32Array(dustCount);
  const dAlphas = new Float32Array(dustCount);

  const dustPalette = [
    new THREE.Color('#a78bfa'),
    new THREE.Color('#60a5fa'),
    new THREE.Color('#22d3ee'),
    new THREE.Color('#fb7185'),
    new THREE.Color('#fbbf24')
  ];
  const white = new THREE.Color('#ffffff');

  for (let i = 0; i < dustCount; i++) {
    const radius = Math.pow(Math.random(), 1.65) * galaxyRadius;
    const armIndex = Math.floor(Math.random() * arms);
    const baseAngle = (armIndex / arms) * Math.PI * 2.0;
    const spiralAngle = radius * twist;
    const angleJitter = randomNormal() * (armSpread * 0.85) * (0.35 + 0.65 * (1.0 - radius / galaxyRadius));
    const angle = baseAngle + spiralAngle + angleJitter;

    const armDensity = Math.exp(-0.5 * Math.pow(angleJitter / (armTightness * 1.15), 2));
    const x = Math.cos(angle) * radius + randomNormal() * (radius * 0.03);
    const z = Math.sin(angle) * radius + randomNormal() * (radius * 0.03);
    const y = randomNormal() * (diskThickness * 1.45) * (0.25 + 0.75 * (1.0 - radius / galaxyRadius));

    dPositions[i * 3] = x;
    dPositions[i * 3 + 1] = y;
    dPositions[i * 3 + 2] = z;

    const t = Math.min(1, radius / galaxyRadius);
    const paletteColor = dustPalette[(armIndex + Math.floor(Math.random() * 2)) % dustPalette.length];
    tempColor.copy(paletteColor);
    tempColor.lerp(white, 0.08 + Math.random() * 0.08);
    tempColor.multiplyScalar((0.22 + 0.55 * armDensity) * (0.55 + 0.45 * (1.0 - t)));

    dColors[i * 3] = tempColor.r;
    dColors[i * 3 + 1] = tempColor.g;
    dColors[i * 3 + 2] = tempColor.b;

    dSizes[i] = (6.0 + Math.random() * 18.0) * (1.05 - 0.45 * t);
    dAlphas[i] = Math.min(0.55, (0.12 + 0.38 * armDensity) * (0.65 + Math.random() * 0.35));
  }

  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dPositions, 3));
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dColors, 3));
  dustGeometry.setAttribute('size', new THREE.BufferAttribute(dSizes, 1));
  dustGeometry.setAttribute('alpha', new THREE.BufferAttribute(dAlphas, 1));

  const dustMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true
  });

  const dustPoints = new THREE.Points(dustGeometry, dustMaterial);
  galaxyPoints.add(dustPoints);

  const bgCount = 5200;
  const bgGeometry = new THREE.BufferGeometry();
  const bPositions = new Float32Array(bgCount * 3);
  const bColors = new Float32Array(bgCount * 3);
  const bSizes = new Float32Array(bgCount);
  const bAlphas = new Float32Array(bgCount);

  const bgColorA = new THREE.Color('#cfe9ff');
  const bgColorB = new THREE.Color('#ffffff');

  for (let i = 0; i < bgCount; i++) {
    const r = 2200 + Math.pow(Math.random(), 0.35) * 3400;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.sin(theta);
    bPositions[i * 3] = x;
    bPositions[i * 3 + 1] = y;
    bPositions[i * 3 + 2] = z;

    tempColor.copy(bgColorA).lerp(bgColorB, Math.random());
    const dim = 0.55 + Math.random() * 0.45;
    tempColor.multiplyScalar(dim);
    bColors[i * 3] = tempColor.r;
    bColors[i * 3 + 1] = tempColor.g;
    bColors[i * 3 + 2] = tempColor.b;

    bSizes[i] = 6 + Math.random() * 12;
    bAlphas[i] = 0.65 + Math.random() * 0.35;
  }

  bgGeometry.setAttribute('position', new THREE.BufferAttribute(bPositions, 3));
  bgGeometry.setAttribute('color', new THREE.BufferAttribute(bColors, 3));
  bgGeometry.setAttribute('size', new THREE.BufferAttribute(bSizes, 1));
  bgGeometry.setAttribute('alpha', new THREE.BufferAttribute(bAlphas, 1));

  const bgMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true
  });

  backgroundPoints = new THREE.Points(bgGeometry, bgMaterial);
  scene.add(backgroundPoints);

  nebulaSharedTexture = makeSoftAlphaTexture();
  const nebulaColors = [
    new THREE.Color('#a78bfa'),
    new THREE.Color('#60a5fa'),
    new THREE.Color('#22d3ee'),
    new THREE.Color('#fb7185'),
    new THREE.Color('#fbbf24'),
    new THREE.Color('#34d399')
  ];

  for (let i = 0; i < 14; i++) {
    const radius = 280 + Math.pow(Math.random(), 0.85) * 980;
    const armIndex = Math.floor(Math.random() * arms);
    const baseAngle = (armIndex / arms) * Math.PI * 2.0;
    const angle = baseAngle + radius * twist + randomNormal() * (armSpread * 0.55);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebulaSharedTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.12 + Math.random() * 0.18,
      color: nebulaColors[(armIndex + i) % nebulaColors.length]
    }));

    sprite.position.set(
      Math.cos(angle) * radius + randomNormal() * (radius * 0.08),
      randomNormal() * (diskThickness * 1.1),
      Math.sin(angle) * radius + randomNormal() * (radius * 0.08)
    );

    const s = 520 + Math.random() * 780;
    sprite.scale.set(s, s, 1);
    galaxyPoints.add(sprite);
    nebulaSprites.push(sprite);
  }

  const coreTexture = makeRadialTexture();
  const coreMaterial = new THREE.SpriteMaterial({
    map: coreTexture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.92,
    color: 0xffffff
  });
  coreSprite = new THREE.Sprite(coreMaterial);
  coreSprite.scale.set(1100, 1100, 1);
  coreSprite.position.set(0, 0, 0);
  scene.add(coreSprite);
};

const initThree = () => {
  if (!starCanvas.value) return;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    60,
    1,
    0.1,
    5000
  );
  camera.position.set(0, 140, 820);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({
    canvas: starCanvas.value,
    alpha: true,
    antialias: true
  });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  handleResize();

  createGalaxy();

  const animate = () => {
    animationId = requestAnimationFrame(animate);

    if (galaxyPoints) {
      galaxyPoints.rotation.z += 0.00045;
    }
    if (backgroundPoints) {
      backgroundPoints.rotation.y += 0.00008;
    }

    renderer.render(scene, camera);
  };

  animate();

  window.addEventListener('resize', handleResize);
};

const handleResize = () => {
  if (!camera || !renderer || !starCanvas.value) return;
  const rect = starCanvas.value.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
};

const cleanupThree = () => {
  if (animationId) {
    cancelAnimationFrame(animationId);
  }

  window.removeEventListener('resize', handleResize);

  if (scene) {
    if (galaxyPoints) {
      scene.remove(galaxyPoints);
      if (galaxyPoints.geometry) galaxyPoints.geometry.dispose();
      if (galaxyPoints.material) galaxyPoints.material.dispose();
    }
    if (backgroundPoints) {
      scene.remove(backgroundPoints);
      if (backgroundPoints.geometry) backgroundPoints.geometry.dispose();
      if (backgroundPoints.material) backgroundPoints.material.dispose();
    }
    if (coreSprite) {
      scene.remove(coreSprite);
      if (coreSprite.material) {
        if (coreSprite.material.map) coreSprite.material.map.dispose();
        coreSprite.material.dispose();
      }
    }
  }

  if (renderer) {
    renderer.dispose();
  }
};

onMounted(() => {
  loadFromStorage();
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => _fetch(input, withAuthHeaders(init));

  const canTalkToServer = () => !needAuth.value || Boolean(String(clawhiveToken.value || '').trim());

  function bootstrapServerSession() {
    if (!canTalkToServer()) return;
    ensureRagUserId();
    loadSessionHistoryList();
    const existingId = readTabRagSessionId();
    if (existingId) {
      conversationId.value = existingId;
      restoreSessionFeedback();
      void hydrateSessionFeedbackFromServer(existingId);
      void loadSessionFromServer(existingId);
    } else {
      ensureConversationId();
      restoreSessionFeedback();
    }
    void fetchServerSessionHistory();
    fetchDocuments();
    refreshIntel();
  }

  bootstrapServerSession();
  watch(clawhiveToken, (t, prev) => {
    if (t && !prev && needAuth.value) bootstrapServerSession();
  });
  initThree();
});

onUnmounted(() => {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  for (const instance of chartState.instances.values()) instance.dispose();
  chartState.instances.clear();
  cleanupThree();
});
</script>

<style scoped>
.user-message-text {
  font-size: 0.92rem;
  line-height: 1.6;
  font-weight: 500;
}
.assistant-message-shell {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.rag-answer-main {
  font-size: 0.9rem;
  line-height: 1.65;
}
.rag-answer-body :deep(strong) {
  color: rgba(248, 250, 252, 0.98);
  font-weight: 600;
}
.rag-answer-body :deep(p) {
  margin: 0;
  color: rgba(248, 250, 252, 0.96);
  line-height: 1.7;
  font-size: 0.92rem;
}
.rag-answer-body :deep(p + p) {
  margin-top: 0.7rem;
}
.rag-answer-body :deep(ul),
.rag-answer-body :deep(ol) {
  margin: 0.5rem 0 0;
  padding-left: 1.15rem;
}
.rag-answer-body :deep(li) {
  color: rgba(248, 250, 252, 0.94);
  margin-top: 0.25rem;
}
.rag-reply-footer {
  margin-top: 0.55rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}
.rag-footer-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.rag-footer-sources {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  min-width: 0;
  flex: 1;
}
.rag-footer-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.rag-strategy-hint {
  font-size: 0.62rem;
  color: rgba(100, 116, 139, 0.85);
  white-space: nowrap;
}
.rag-evidence-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.66rem;
  color: rgba(125, 211, 252, 0.95);
  background: rgba(14, 165, 233, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.22);
  border-radius: 9999px;
  padding: 0.16rem 0.5rem;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  white-space: nowrap;
}
.rag-evidence-toggle:hover {
  background: rgba(14, 165, 233, 0.16);
  border-color: rgba(56, 189, 248, 0.38);
}
.rag-evidence-toggle-count {
  font-size: 0.62rem;
  color: rgba(148, 163, 184, 0.9);
}
.rag-evidence-collapse-enter-active,
.rag-evidence-collapse-leave-active {
  transition: opacity 0.18s ease, max-height 0.22s ease;
  overflow: hidden;
}
.rag-evidence-collapse-enter-from,
.rag-evidence-collapse-leave-to {
  opacity: 0;
  max-height: 0;
}
.rag-evidence-collapse-enter-to,
.rag-evidence-collapse-leave-from {
  opacity: 1;
  max-height: 240px;
}
.rag-evidence-panel {
  margin-top: 0.45rem;
  padding: 0.45rem 0.5rem;
  border-radius: 0.55rem;
  border: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(15, 23, 42, 0.42);
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 116, 139, 0.45) transparent;
}
.rag-evidence-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.rag-evidence-item {
  padding: 0.4rem 0.45rem;
  border-radius: 0.45rem;
  background: rgba(2, 6, 23, 0.28);
}
.rag-evidence-item-head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.2rem;
}
.rag-evidence-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border-radius: 9999px;
  font-size: 0.58rem;
  font-weight: 600;
  color: rgba(186, 230, 253, 0.9);
  background: rgba(14, 165, 233, 0.15);
  flex-shrink: 0;
}
.rag-evidence-source-inline {
  font-size: 0.62rem;
  font-weight: 500;
  color: rgba(125, 211, 252, 0.92);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: rgba(56, 189, 248, 0.35);
}
.rag-evidence-source-inline:hover {
  color: rgba(186, 230, 253, 1);
}
.rag-evidence-quote {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.rag-evidence-quote :deep(.ev-heading) {
  font-size: 0.68rem;
  font-weight: 600;
  color: rgba(186, 230, 253, 0.82);
  margin-bottom: 0.12rem;
}
.rag-evidence-quote :deep(.ev-line) {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.45;
  color: rgba(203, 213, 225, 0.78);
}
.rag-evidence-quote :deep(.ev-bullet) {
  display: flex;
  gap: 0.3rem;
  font-size: 0.72rem;
  line-height: 1.4;
  color: rgba(203, 213, 225, 0.78);
}
.rag-evidence-quote :deep(.ev-bullet-dot) {
  color: rgba(56, 189, 248, 0.65);
  flex-shrink: 0;
}
.rag-sources-inline {
  margin-top: 0.65rem;
  padding-top: 0.55rem;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}
.rag-sources-label {
  font-size: 0.64rem;
  color: rgba(148, 163, 184, 0.75);
  flex-shrink: 0;
}
.rag-source-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.rag-source-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  border: 1px solid rgba(56, 189, 248, 0.28);
  background: rgba(14, 165, 233, 0.1);
  padding: 0.18rem 0.55rem;
  font-size: 0.68rem;
  color: rgba(186, 230, 253, 0.95);
  cursor: pointer;
  transition: background 0.15s ease;
}
.rag-source-chip:hover {
  background: rgba(14, 165, 233, 0.22);
}
.formatted-answer :deep(p) {
  margin: 0;
}
.formatted-answer :deep(p + p) {
  margin-top: 0.6rem;
}
.formatted-answer :deep(ul),
.formatted-answer :deep(ol) {
  margin: 0.65rem 0;
  padding-left: 1.2rem;
}
.formatted-answer :deep(li + li) {
  margin-top: 0.2rem;
}
.formatted-answer :deep(pre) {
  margin: 0.75rem 0;
  overflow-x: auto;
  border-radius: 1rem;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(2, 6, 23, 0.88);
  padding: 0.9rem 1rem;
}
.formatted-answer :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 0.9em;
}
.formatted-answer :deep(:not(pre) > code) {
  border-radius: 0.45rem;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.16);
  padding: 0.12rem 0.34rem;
}
.formatted-answer :deep(table) {
  border-collapse: collapse;
  width: 100%;
  background: rgba(2, 6, 23, 0.35);
}
.formatted-answer :deep(th),
.formatted-answer :deep(td) {
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  padding: 0.55rem 0.7rem;
  text-align: left;
  vertical-align: top;
}
.formatted-answer :deep(th) {
  font-size: 0.72rem;
  color: rgba(191, 219, 254, 0.9);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: rgba(15, 23, 42, 0.9);
}
.formatted-answer :deep(footer button) {
  margin-top: 0.25rem;
}
.echarts-shell {
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.84), rgba(2, 6, 23, 0.9));
}
.echarts-canvas {
  min-height: 18rem;
}
.table-scroll {
  scrollbar-width: thin;
}

.msg-action-btn {
  font-size: 11px;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  padding: 0.15rem 0.55rem;
  color: rgba(241, 245, 249, 0.92);
}
.msg-action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
}
.msg-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.msg-action-primary {
  border-color: rgba(56, 189, 248, 0.35);
  background: rgba(14, 165, 233, 0.22);
}

.rag-process-panel {
  border-radius: 0.75rem;
  border: 1px solid rgba(56, 189, 248, 0.18);
  background: rgba(2, 6, 23, 0.45);
  overflow: hidden;
}
.rag-process-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.65rem;
  font-size: 11px;
  color: rgba(186, 230, 253, 0.92);
  text-align: left;
}
.rag-process-toggle:hover {
  background: rgba(56, 189, 248, 0.08);
}
.rag-process-count {
  color: rgba(148, 163, 184, 0.85);
  font-size: 10px;
}
.rag-process-elapsed {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: rgba(125, 211, 252, 0.95);
  font-size: 10px;
}
.rag-process-chevron {
  color: rgba(148, 163, 184, 0.75);
  font-size: 10px;
}
.rag-process-steps {
  border-top: 1px solid rgba(56, 189, 248, 0.12);
  padding: 0.35rem 0.55rem 0.5rem;
  max-height: 16rem;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.35) rgba(15, 23, 42, 0.4);
}
.rag-process-step {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  font-size: 11px;
  line-height: 1.45;
  color: rgba(203, 213, 225, 0.88);
  padding: 0.2rem 0;
}
.rag-process-step-ms {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: rgba(125, 211, 252, 0.75);
  font-size: 9px;
}
.rag-process-step.kind-phase .rag-process-dot {
  background: rgba(56, 189, 248, 0.95);
}
.rag-process-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  margin-top: 0.35rem;
  flex-shrink: 0;
  background: rgba(56, 189, 248, 0.65);
}
.rag-process-step.kind-node .rag-process-dot {
  background: rgba(167, 139, 250, 0.8);
}
.rag-process-step.kind-tool .rag-process-dot {
  background: rgba(52, 211, 153, 0.85);
}
.rag-process-step.kind-status .rag-process-text {
  color: rgba(186, 230, 253, 0.95);
}
</style>
