import { CreateWebWorkerMLCEngine } from "https://esm.run/@mlc-ai/web-llm@0.2.83";
import {
    searchWikipedia,
    fetchArticleContent,
    fetchMultipleArticles,
    getPopularArticles,
    saveArticle,
    getAllArticles,
    deleteArticle,
    getArticleCount,
    clearAllArticles,
    searchKnowledgeBase,
    performLiveInternetSearch,
} from "./knowledge.js";

// ===== State Management =====
const state = {
    engine: null,
    isGenerating: false,
    isModelLoaded: false,
    currentChatId: null,
    chats: {},
    kbArticleCount: 0, // cached count to skip RAG when empty
    settings: {
        model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
        systemPrompt: "You are a free thinking, brilliant AI assistant with deep reasoning capabilities. You are encouraged to explore ideas creatively. However, you must be strictly grounded in facts and never hallucinate or invent information. If you do not know a fact, state it clearly. You are restricted to English and Farsi only; do not use any other languages. Use clear, varied sentence structures and perfect spelling. Do not use hyphens in your responses.",
        temperature: 0.3,
        maxTokens: 512,
        theme: "obsidian",
    },
};

// ===== DOM Elements =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
    chatArea: $("#chat-area"),
    welcomeScreen: $("#welcome-screen"),
    messagesContainer: $("#messages-container"),
    messageInput: $("#message-input"),
    sendBtn: $("#send-btn"),
    stopBtn: $("#stop-btn"),
    newChatBtn: $("#new-chat-btn"),
    chatList: $("#chat-list"),
    chatTitle: $("#chat-title"),
    loadingOverlay: $("#loading-overlay"),
    loadingTitle: $("#loading-title"),
    loadingSubtitle: $("#loading-subtitle"),
    progressBar: $("#progress-bar"),
    progressText: $("#progress-text"),
    statusBadge: $("#status-badge"),
    statusText: $(".status-text"),
    modelNameDisplay: $("#model-name-display"),
    sidebarToggle: $("#sidebar-toggle"),
    sidebar: $("#sidebar"),
    settingsBtn: $("#settings-btn"),
    settingsModal: $("#settings-modal"),
    closeSettings: $("#close-settings"),
    modelSelect: $("#model-select"),
    themeSelect: $("#theme-select"),
    systemPrompt: $("#system-prompt"),
    temperature: $("#temperature"),
    tempValue: $("#temp-value"),
    maxTokens: $("#max-tokens"),
    applySettings: $("#apply-settings"),
    // Knowledge Base
    knowledgeBtn: $("#knowledge-btn"),
    knowledgeModal: $("#knowledge-modal"),
    closeKnowledge: $("#close-knowledge"),
    kbBadge: $("#kb-badge"),
    kbSearchInput: $("#kb-search-input"),
    kbSearchBtn: $("#kb-search-btn"),
    kbSearchResults: $("#kb-search-results"),
    kbBulkDownload: $("#kb-bulk-download"),
    kbBulkProgress: $("#kb-bulk-progress"),
    kbProgressBar: $("#kb-progress-bar"),
    kbProgressText: $("#kb-progress-text"),
    kbArticleList: $("#kb-article-list"),
    kbCountLabel: $("#kb-count-label"),
    kbClearAll: $("#kb-clear-all"),
    // Deep Crawler
    kbCrawlerBtn: $("#kb-crawler-btn"),
    kbCrawlerProgress: $("#kb-crawler-progress"),
    kbCrawlerText: $("#kb-crawler-text"),
    // File Upload
    fileInput: $("#file-input"),
    fileUploadBtn: $("#file-upload-btn"),
    filePreview: $("#file-preview"),
    // Update
    updateBtn: $("#update-btn"),
};

// Pending file attachments
let pendingFiles = [];

// ===== Persistence =====
function saveState() {
    try {
        localStorage.setItem("horizon-chats", JSON.stringify(state.chats));
        localStorage.setItem("horizon-settings", JSON.stringify(state.settings));
        localStorage.setItem("horizon-currentChat", state.currentChatId);
    } catch (e) {
        console.warn("Failed to save state:", e);
    }
}

function loadState() {
    try {
        const chats = localStorage.getItem("horizon-chats");
        const settings = localStorage.getItem("horizon-settings");
        const currentChat = localStorage.getItem("horizon-currentChat");

        if (chats) state.chats = JSON.parse(chats);
        if (settings) state.settings = { ...state.settings, ...JSON.parse(settings) };
        if (currentChat) state.currentChatId = currentChat;
    } catch (e) {
        console.warn("Failed to load state:", e);
    }
}

// ===== Model Management =====
async function initEngine() {
    els.loadingOverlay.classList.remove("hidden");
    els.statusBadge.className = "status-badge loading";
    els.statusText.textContent = "Loading model...";

    try {
        // Use Web Worker engine — runs inference off the main thread
        // so the UI stays buttery smooth during generation
        const worker = new Worker(
            new URL("./worker.js", import.meta.url),
            { type: "module" }
        );

        state.engine = await CreateWebWorkerMLCEngine(worker, state.settings.model, {
            initProgressCallback: (progress) => {
                const text = progress.text || "";
                const pct = progress.progress ? Math.round(progress.progress * 100) : 0;

                els.progressBar.style.width = pct + "%";
                els.progressText.textContent = pct + "%";

                if (text.includes("Fetching")) {
                    els.loadingSubtitle.textContent = "Downloading model files...";
                } else if (text.includes("Loading")) {
                    els.loadingSubtitle.textContent = "Loading model into GPU memory...";
                } else {
                    els.loadingSubtitle.textContent = text || "Preparing...";
                }
            },
        });

        // Warmup: run a tiny inference to prime the GPU pipeline
        // This makes the first real response much faster
        els.loadingSubtitle.textContent = "Warming up GPU...";
        try {
            await state.engine.chat.completions.create({
                messages: [{ role: "user", content: "Hi" }],
                max_tokens: 1,
                temperature: 0,
            });
            // Reset KV cache after warmup
            await state.engine.resetChat();
        } catch (e) {
            console.warn("Warmup failed (non-critical):", e);
        }

        state.isModelLoaded = true;
        els.loadingOverlay.classList.add("hidden");
        els.statusBadge.className = "status-badge";
        els.statusText.textContent = "Online — In-Browser";
        els.messageInput.disabled = false;
        els.messageInput.focus();
        updateModelDisplay();

        console.log("✅ Model loaded + warmed up (Web Worker)");
    } catch (err) {
        console.error("Failed to load model:", err);
        els.loadingTitle.textContent = "Failed to Load Model";
        els.loadingSubtitle.textContent = getErrorMessage(err);
        els.progressBar.style.width = "0%";
        els.progressText.textContent = "Error";
        els.statusBadge.className = "status-badge error";
        els.statusText.textContent = "Error";
    }
}

function getErrorMessage(err) {
    const msg = err.message || String(err);
    if (msg.includes("WebGPU")) {
        return "Your browser doesn't support WebGPU. Please use Chrome 113+ or Edge 113+.";
    }
    if (msg.includes("storage")) {
        return "Insufficient storage space. Try clearing browser data or use a smaller model.";
    }
    return "An error occurred: " + msg;
}

function updateModelDisplay() {
    const modelNames = {
        "SmolLM2-135M-Instruct-q0f16-MLC": "Mercury ⚡",
        "SmolLM2-360M-Instruct-q4f16_1-MLC": "Venus",
        "Llama-3.2-1B-Instruct-q4f16_1-MLC": "Earth",
        "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": "Mars",
        "Llama-3.2-3B-Instruct-q4f16_1-MLC": "Jupiter",
    };
    els.modelNameDisplay.textContent = modelNames[state.settings.model] || state.settings.model;
}

// ===== Chat Management =====
function createChat() {
    const id = "chat_" + Date.now();
    state.chats[id] = {
        id,
        title: "New Chat",
        messages: [],
        createdAt: Date.now(),
    };
    state.currentChatId = id;
    saveState();
    renderChatList();
    renderMessages();
    els.messageInput.value = "";
    autoResize(els.messageInput);
    return id;
}

function deleteChat(id) {
    delete state.chats[id];
    if (state.currentChatId === id) {
        const ids = Object.keys(state.chats);
        state.currentChatId = ids.length > 0 ? ids[ids.length - 1] : null;
    }
    saveState();
    renderChatList();
    renderMessages();
    els.messageInput.value = "";
    autoResize(els.messageInput);
}

function switchChat(id) {
    state.currentChatId = id;
    saveState();
    renderChatList();
    renderMessages();
    els.messageInput.value = "";
    autoResize(els.messageInput);
}

function getCurrentChat() {
    if (!state.currentChatId || !state.chats[state.currentChatId]) {
        return null;
    }
    return state.chats[state.currentChatId];
}

// Auto-generate a basic title immediately
function autoTitle(chat) {
    const userMessages = chat.messages.filter((m) => m.role === "user");
    const latestUserMsg = userMessages[userMessages.length - 1];
    if (latestUserMsg) {
        let textContent = latestUserMsg.content;
        if (Array.isArray(textContent)) {
            const textPart = textContent.find(p => p.type === "text");
            textContent = textPart ? textPart.text : "Image prompt";
        }
        chat.title = textContent.slice(0, 40) + (textContent.length > 40 ? "..." : "");
    }
}

// Generate a custom title using the LLM
async function generateAI_Title(chat) {
    const userMessages = chat.messages.filter((m) => m.role === "user");
    const latestUserMsg = userMessages[userMessages.length - 1];
    
    if (latestUserMsg && state.engine) {
        let textContent = latestUserMsg.content;
        if (Array.isArray(textContent)) {
            const textPart = textContent.find(p => p.type === "text");
            textContent = textPart ? textPart.text : "";
        }
        
        if (!textContent) return;
        
        try {
            const response = await state.engine.chat.completions.create({
                messages: [
                    { role: "system", content: "You are a title generator. Summarize the user's prompt into a 2-5 word title. Respond ONLY with the title, no quotes, no extra text, no internal monologue." },
                    { role: "user", content: textContent.substring(0, 500) }
                ],
                temperature: 0.3,
                max_tokens: 15
            });
            
            const generatedTitle = response.choices[0]?.message?.content?.trim();
            if (generatedTitle) {
                // Strip quotes if the LLM adds them anyway, and remove any <think> tags if they leak
                let cleanTitle = generatedTitle.replace(/^["']|["']$/g, "");
                cleanTitle = cleanTitle.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
                if (cleanTitle) {
                    chat.title = cleanTitle;
                }
            }
        } catch (e) {
            console.warn("Failed to generate AI title", e);
        }
    }
}

// ===== Rendering =====
function renderChatList() {
    const sortedChats = Object.values(state.chats).sort((a, b) => b.createdAt - a.createdAt);

    els.chatList.innerHTML = sortedChats
        .map(
            (chat) => `
        <div class="chat-item ${chat.id === state.currentChatId ? "active" : ""}" data-chat-id="${chat.id}">
            <svg class="chat-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <span class="chat-item-text">${escapeHTML(chat.title)}</span>
            <button class="chat-item-delete" data-delete-id="${chat.id}" title="Delete chat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        </div>
    `
        )
        .join("");

    // Bind events
    els.chatList.querySelectorAll(".chat-item").forEach((el) => {
        el.addEventListener("click", (e) => {
            if (e.target.closest(".chat-item-delete")) return;
            switchChat(el.dataset.chatId);
        });
    });

    els.chatList.querySelectorAll(".chat-item-delete").forEach((el) => {
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteChat(el.dataset.deleteId);
        });
    });
}

function renderMessages() {
    const chat = getCurrentChat();

    if (!chat || chat.messages.length === 0) {
        els.welcomeScreen.classList.remove("hidden");
        els.messagesContainer.classList.add("hidden");
        els.chatTitle.textContent = "New Chat";
        updateNewChatBtn();
        return;
    }

    els.welcomeScreen.classList.add("hidden");
    els.messagesContainer.classList.remove("hidden");
    els.chatTitle.textContent = chat.title;

    els.messagesContainer.innerHTML = chat.messages
        .map(
            (msg) => `
        <div class="message ${msg.role}">
            <div class="message-avatar">
                ${msg.role === "user" ? "Y" : "N"}
            </div>
            <div class="message-content">
                <div class="message-role">${msg.role === "user" ? "You" : "Horizon"}</div>
                <div class="message-text">${formatMessageContent(msg.content)}</div>
            </div>
        </div>
    `
        )
        .join("");

    updateNewChatBtn();
    scrollToBottom();
}

function updateNewChatBtn() {
    const chat = getCurrentChat();
    const isHomepage = !chat || chat.messages.length === 0;
    els.newChatBtn.disabled = isHomepage;
}

function appendMessage(role, content) {
    const chat = getCurrentChat();
    if (!chat) return;

    chat.messages.push({ role, content });
    autoTitle(chat);
    saveState();
    renderChatList();

    els.welcomeScreen.classList.add("hidden");
    els.messagesContainer.classList.remove("hidden");
    els.chatTitle.textContent = chat.title;

    const msgDiv = document.createElement("div");
    msgDiv.className = `message ${role}`;
    msgDiv.innerHTML = `
        <div class="message-avatar">${role === "user" ? "Y" : "N"}</div>
        <div class="message-content">
            <div class="message-role">${role === "user" ? "You" : "Horizon"}</div>
            <div class="message-text">${formatMessageContent(content)}</div>
        </div>
    `;

    els.messagesContainer.appendChild(msgDiv);
    updateNewChatBtn();
    scrollToBottom();
    return msgDiv;
}

function createStreamingMessage() {
    els.welcomeScreen.classList.add("hidden");
    els.messagesContainer.classList.remove("hidden");

    const msgDiv = document.createElement("div");
    msgDiv.className = "message assistant";
    msgDiv.innerHTML = `
        <div class="message-avatar">N</div>
        <div class="message-content">
            <div class="message-role">Horizon</div>
            <div class="message-text cursor-blink"></div>
        </div>
    `;

    els.messagesContainer.appendChild(msgDiv);
    scrollToBottom();
    return msgDiv.querySelector(".message-text");
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        els.chatArea.scrollTop = els.chatArea.scrollHeight;
    });
}

// ===== Text Formatting =====
function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function formatMessageContent(content) {
    if (typeof content === "string") {
        return formatMessage(content);
    }
    if (Array.isArray(content)) {
        let html = "";
        for (const part of content) {
            if (part.type === "text") {
                html += formatMessage(part.text);
            } else if (part.type === "image_url") {
                html += `<img src="${part.image_url.url}" class="chat-img-attachment">`;
            }
        }
        return html;
    }
    return "";
}

function formatMessage(text) {
    // Escape HTML
    let formatted = escapeHTML(text);

    // Code blocks (```)
    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic
    formatted = formatted.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Line breaks → paragraphs
    formatted = formatted
        .split("\n\n")
        .map((p) => `<p>${p}</p>`)
        .join("");
    formatted = formatted.replace(/\n/g, "<br>");

    return formatted;
}

// ===== Chat Completion =====
// Throttle DOM updates during streaming to avoid layout thrashing
let _streamRAF = null;
let _pendingStreamHTML = null;

function flushStreamUpdate(streamEl) {
    if (_pendingStreamHTML !== null) {
        streamEl.innerHTML = _pendingStreamHTML;
        streamEl.classList.add("cursor-blink");
        _pendingStreamHTML = null;
        scrollToBottom();
    }
    _streamRAF = null;
}

function scheduleStreamUpdate(streamEl, html) {
    _pendingStreamHTML = html;
    if (!_streamRAF) {
        _streamRAF = requestAnimationFrame(() => flushStreamUpdate(streamEl));
    }
}

function renderFilePreview() {
    if (pendingFiles.length === 0) {
        els.filePreview.classList.add("hidden");
        els.filePreview.innerHTML = "";
        return;
    }
    els.filePreview.classList.remove("hidden");
    els.filePreview.innerHTML = pendingFiles.map((f, i) => {
        let icon = '<span class="file-chip-icon">📄</span>';
        if (f.type && f.type.startsWith("image/")) {
            icon = `<img src="${f.content}" class="file-preview-img" alt="${f.name}">`;
        }
        return `
        <div class="file-chip">
            ${icon}
            <span class="file-chip-name">${f.name}</span>
            <button class="file-chip-remove" data-file-index="${i}" title="Remove">&times;</button>
        </div>
        `;
    }).join("");

    els.filePreview.querySelectorAll(".file-chip-remove").forEach(btn => {
        btn.addEventListener("click", () => {
            const idx = parseInt(btn.dataset.fileIndex);
            pendingFiles.splice(idx, 1);
            renderFilePreview();
        });
    });
}

// ===== Language Detection =====
function detectLanguage(text) {
    // Detect Farsi/Arabic script characters
    const farsiPattern = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
    if (farsiPattern.test(text)) {
        return "farsi";
    }
    return "english";
}

// ===== Internal Monologue Stripper =====
function stripInternalMonologue(text) {
    // Remove anything wrapped in <think>...</think> tags (hidden reasoning)
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ===== Syntax Guard =====
function syntaxGuard(text) {
    // 1. Replace all hyphens with appropriate alternatives
    // Replace hyphens used as dashes with an em dash
    let cleaned = text.replace(/\s+\-\s+/g, " \u2014 ");
    // Replace remaining hyphens between words with a space
    cleaned = cleaned.replace(/([a-zA-Z])\-([a-zA-Z])/g, "$1 $2");
    // Remove any standalone hyphens that slipped through
    cleaned = cleaned.replace(/\-/g, "");

    // 2. Basic spelling corrections for common errors
    const corrections = {
        "teh": "the",
        "recieve": "receive",
        "occured": "occurred",
        "seperate": "separate",
        "definately": "definitely",
        "occurence": "occurrence",
        "accomodate": "accommodate",
        "neccessary": "necessary",
        "independant": "independent",
        "goverment": "government",
        "enviroment": "environment",
        "knowlege": "knowledge",
        "langauge": "language",
        "responce": "response",
        "togeather": "together",
        "beleive": "believe",
        "acheive": "achieve",
        "begining": "beginning",
        "comming": "coming",
        "untill": "until",
    };

    for (const [wrong, right] of Object.entries(corrections)) {
        const regex = new RegExp("\\b" + wrong + "\\b", "gi");
        cleaned = cleaned.replace(regex, right);
    }

    return cleaned;
}

// ===== Logit Processor (Script Filter) =====
// Since WebLLM does not expose raw logits in the browser,
// this acts as a post generation vocabulary filter.
// It strips any characters from disallowed scripts (Cyrillic,
// CJK, Kanji, Devanagari, etc.) while keeping English (Latin),
// Farsi (Arabic script), numbers, and standard punctuation.
function scriptFilter(text) {
    // Whitelist pattern:
    //   \u0000-\u007F  = Basic Latin (English + ASCII punctuation + numbers)
    //   \u00A0-\u00FF  = Latin supplement (accented chars)
    //   \u0600-\u06FF  = Arabic (covers Farsi/Persian)
    //   \uFB50-\uFDFF  = Arabic Presentation Forms A
    //   \uFE70-\uFEFF  = Arabic Presentation Forms B
    //   \u200C-\u200F  = Zero width joiners (used in Farsi text)
    //   \u2000-\u206F  = General punctuation (em dashes, quotes, etc.)
    //   \n\r\t          = Whitespace
    const allowed = /[^\u0000-\u007F\u00A0-\u00FF\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF\u200C-\u200F\u2000-\u206F]/g;
    const filtered = text.replace(allowed, "");
    // Collapse any runs of extra spaces left behind
    return filtered.replace(/  +/g, " ").trim();
}

// ===== Repetition Loop Detector =====
// Detects when the model gets stuck repeating the same phrase.
// If a repeated segment is found, it truncates the output
// to just before the loop began.
function detectRepetitionLoop(text, minPhraseLen = 20, maxRepeats = 3) {
    // Slide through the text looking for repeated segments
    const len = text.length;
    if (len < minPhraseLen * maxRepeats) return text;

    for (let phraseLen = minPhraseLen; phraseLen <= 80; phraseLen++) {
        // Check from the end of the text backwards
        const tail = text.slice(len - phraseLen);
        let repeatCount = 0;
        let pos = len - phraseLen;

        while (pos >= phraseLen) {
            const segment = text.slice(pos - phraseLen, pos);
            if (segment === tail) {
                repeatCount++;
                pos -= phraseLen;
            } else {
                break;
            }
        }

        if (repeatCount >= maxRepeats) {
            // Found a repetition loop; truncate before it started
            const cutPoint = len - (phraseLen * (repeatCount + 1));
            const truncated = text.slice(0, Math.max(cutPoint, 0)).trim();
            console.warn("[Timeout] Repetition loop detected. Truncating output.");
            return truncated || "I was unable to generate a clear response. Please try rephrasing your question.";
        }
    }

    return text;
}

async function sendMessage(content) {
    if (!state.isModelLoaded || state.isGenerating || !content.trim()) return;

    // Create a chat only if there isn't one yet
    if (!getCurrentChat()) {
        createChat();
    }

    let chat = getCurrentChat();

    state.isGenerating = true;

    // UI updates
    els.sendBtn.classList.add("hidden");
    els.stopBtn.classList.remove("hidden");
    els.messageInput.disabled = true;
    els.messageInput.value = "";
    autoResize(els.messageInput);

    // Check for images
    const imageFiles = pendingFiles.filter(f => f.type === "image");
    const textFiles = pendingFiles.filter(f => f.type !== "image");
    
    let finalContent = content;

    if (imageFiles.length > 0) {
        finalContent = [{ type: "text", text: content }];
        for (const img of imageFiles) {
            finalContent.push({ type: "image_url", image_url: { url: img.content } });
        }
        
        // Auto-switch to Vision model if using a text-only model
        const currentModel = state.settings.model.toLowerCase();
        if (!currentModel.includes("vision") && !currentModel.includes("vl")) {
            console.log("Auto-switching to Vision model for image support");
            state.settings.model = "Llama-3.2-11B-Vision-Instruct-q4f16_1-MLC";
            els.modelSelect.value = state.settings.model;
            saveState();
            updateModelDisplay();
            state.isModelLoaded = false;
            await initEngine();
        }
    }

    // Add user message
    appendMessage("user", finalContent);

    // Create thinking message placeholder
    const streamEl = createStreamingMessage();
    streamEl.innerHTML = '<span class="thinking-indicator">Thinking...</span>';
    let fullResponse = "";

    try {
        // Build messages array with system prompt
        let systemContent = state.settings.systemPrompt;

        // Language detection: enforce response language based on query
        const queryLang = detectLanguage(content);
        if (queryLang === "farsi") {
            systemContent += "\n\nThe user is writing in Farsi. Respond in Farsi only.";
        } else {
            systemContent += "\n\nThe user is writing in English. Respond in English only.";
        }

        // Internal Monologue: instruct the model to plan before answering
        systemContent += "\n\nBefore answering, write your internal reasoning inside <think></think> tags. This will be hidden from the user. After the closing </think> tag, write your final polished answer.";

        // Attach uploaded text files as context
        if (textFiles.length > 0) {
            let fileContext = "\n\nThe user has uploaded the following files:\n";
            for (const f of textFiles) {
                const truncated = f.content.slice(0, 4000);
                fileContext += `\n--- File: ${f.name} ---\n${truncated}\n`;
            }
            systemContent += fileContext;
        }
        pendingFiles = [];
        renderFilePreview();

        // RAG: Dynamic Online/Offline Search
        let ragContext = null;
        let ragSource = "";

        if (navigator.onLine) {
            // Online Mode: Live Internet Search
            try {
                ragContext = await performLiveInternetSearch(content);
                if (ragContext) {
                    ragSource = "🌍 Using Live Internet";
                }
            } catch (e) {
                console.warn("Live internet search failed:", e);
            }
        } 
        
        // Fallback to Offline Mode if offline or live search yielded nothing
        if (!ragContext && state.kbArticleCount > 0) {
            try {
                ragContext = await searchKnowledgeBase(content, 2, 800);
                if (ragContext) {
                    ragSource = "📚 Using Offline Wikipedia brain";
                }
            } catch (e) {
                console.warn("Offline RAG search failed:", e);
            }
        }

        if (ragContext) {
            systemContent += "\n\nYou have access to the following reference material. Use it to inform your answer but always paraphrase in your own words. Never copy text directly from the reference.\n\nReference:\n" + ragContext;
            const indicator = document.createElement("div");
            indicator.className = "rag-indicator";
            indicator.textContent = ragSource;
            streamEl.parentElement.insertBefore(indicator, streamEl);
        }

        const messages = [{ role: "system", content: systemContent }];

        // Limit context to last 6 messages for maximum speed
        const recentMessages = chat.messages.slice(-6);
        for (const msg of recentMessages) {
            messages.push({ role: msg.role, content: msg.content });
        }

        // Streaming: generate and display the response progressively
        const chunks = await state.engine.chat.completions.create({
            messages,
            temperature: state.settings.temperature,
            max_tokens: state.settings.maxTokens,
            stream: true,
            top_p: state.settings.temperature === 0 ? 1.0 : 0.9,
            frequency_penalty: 0,
            presence_penalty: 0,
        });

        for await (const chunk of chunks) {
            if (!state.isGenerating) break;

            const text = chunk.choices[0]?.delta?.content || "";
            fullResponse += text;

            let displayResponse = fullResponse;

            // Dynamically hide <think> blocks while they are being generated
            if (displayResponse.includes("<think>") && !displayResponse.includes("</think>")) {
                displayResponse = displayResponse.split("<think>")[0] + "\n\n*Thinking...*";
            } else {
                displayResponse = stripInternalMonologue(displayResponse);
            }

            displayResponse = syntaxGuard(displayResponse);

            // Throttle DOM updates so the browser doesn't freeze
            scheduleStreamUpdate(streamEl, formatMessage(displayResponse));
        }
        
        // Final flush just to be absolutely sure we rendered the last chunk
        flushStreamUpdate(streamEl);
    } catch (err) {
        console.error("Generation error:", err);
        if (!fullResponse) {
            fullResponse = "⚠️ An error occurred during generation. Please try again.";
            streamEl.innerHTML = formatMessage(fullResponse);
        }
    }

    // Finalize
    streamEl.classList.remove("cursor-blink");

    if (fullResponse) {
        chat.messages.push({ role: "assistant", content: fullResponse });
        await generateAI_Title(chat);
        saveState();
        renderChatList();
        els.chatTitle.textContent = chat.title;
    }

    state.isGenerating = false;
    els.sendBtn.classList.remove("hidden");
    els.stopBtn.classList.add("hidden");
    els.messageInput.disabled = false;
    els.messageInput.focus();
    updateSendBtn();
}

function stopGeneration() {
    state.isGenerating = false;
    if (state.engine) {
        state.engine.interruptGenerate();
    }
}

// ===== Input Handling =====
function autoResize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
}

function updateSendBtn() {
    els.sendBtn.disabled = !els.messageInput.value.trim() || !state.isModelLoaded;
}

// ===== Event Listeners =====
function updateConnectionStatus() {
    if (navigator.onLine) {
        els.statusBadge.classList.add("online");
        els.statusText.textContent = "Live Search";
    } else {
        els.statusBadge.classList.remove("online");
        els.statusText.textContent = "Offline Ready";
    }
}

function bindEvents() {
    // Connection status
    window.addEventListener("online", updateConnectionStatus);
    window.addEventListener("offline", updateConnectionStatus);
    updateConnectionStatus(); // Init
    
    // Send message
    els.sendBtn.addEventListener("click", () => {
        sendMessage(els.messageInput.value);
    });

    // Stop generation
    els.stopBtn.addEventListener("click", stopGeneration);

    // Input handling
    els.messageInput.addEventListener("input", () => {
        autoResize(els.messageInput);
        updateSendBtn();
    });

    els.messageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (els.messageInput.value.trim() && state.isModelLoaded) {
                sendMessage(els.messageInput.value);
            }
        }
    });

    // New chat — only allowed when a conversation has messages
    els.newChatBtn.addEventListener("click", () => {
        if (els.newChatBtn.disabled) return;
        createChat();
    });

    // File upload
    els.fileUploadBtn.addEventListener("click", () => {
        els.fileInput.click();
    });

    els.fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            try {
                if (file.type.startsWith("image/")) {
                    const dataUrl = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                    });
                    pendingFiles.push({ name: file.name, type: file.type, content: dataUrl });
                } else {
                    const text = await file.text();
                    pendingFiles.push({ name: file.name, type: "text", content: text });
                }
                renderFilePreview();
            } catch (err) {
                console.warn("Could not read file:", file.name, err);
            }
        }
        els.fileInput.value = "";
    });

    document.addEventListener("paste", async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.indexOf("image") !== -1) {
                const file = item.getAsFile();
                if (!file) continue;
                try {
                    const dataUrl = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                    });
                    pendingFiles.push({ name: "Pasted Image", type: file.type, content: dataUrl });
                    renderFilePreview();
                } catch (err) {
                    console.warn("Could not read pasted image", err);
                }
            }
        }
    });

    // Sidebar toggle
    els.sidebarToggle.addEventListener("click", () => {
        els.sidebar.classList.toggle("collapsed");
    });

    // Settings
    els.settingsBtn.addEventListener("click", () => {
        loadSettingsUI();
        els.settingsModal.classList.remove("hidden");
    });

    els.closeSettings.addEventListener("click", () => {
        els.settingsModal.classList.add("hidden");
    });

    els.settingsModal.addEventListener("click", (e) => {
        if (e.target === els.settingsModal) {
            els.settingsModal.classList.add("hidden");
        }
    });

    els.temperature.addEventListener("input", () => {
        els.tempValue.textContent = els.temperature.value;
    });

    els.applySettings.addEventListener("click", async () => {
        state.settings.model = els.modelSelect.value;
        state.settings.systemPrompt = els.systemPrompt.value;
        state.settings.temperature = parseFloat(els.temperature.value);
        state.settings.maxTokens = parseInt(els.maxTokens.value);
        state.settings.theme = els.themeSelect.value;
        
        document.documentElement.setAttribute("data-theme", state.settings.theme);
        
        saveState();
        els.settingsModal.classList.add("hidden");

        // Reload model if changed
        state.isModelLoaded = false;
        els.messageInput.disabled = true;
        await initEngine();
    });

    // Welcome cards
    $$(".welcome-card").forEach((card) => {
        card.addEventListener("click", () => {
            const prompt = card.dataset.prompt;
            if (prompt) {
                els.messageInput.value = prompt;
                sendMessage(prompt);
            }
        });
    });

    // Keyboard shortcut — same guard as the button
    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.key === "n") {
            e.preventDefault();
            const chat = getCurrentChat();
            if (chat && chat.messages.length > 0) {
                createChat();
            }
        }
    });

    // Update App button
    els.updateBtn.addEventListener("click", async () => {
        els.updateBtn.textContent = "Updating...";
        els.updateBtn.disabled = true;
        try {
            // Unregister all service workers
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const reg of registrations) {
                await reg.unregister();
            }
            // Delete all caches
            const cacheNames = await caches.keys();
            for (const name of cacheNames) {
                await caches.delete(name);
            }
            // Hard reload
            window.location.reload(true);
        } catch (err) {
            console.error("Update failed:", err);
            els.updateBtn.textContent = "Update App";
            els.updateBtn.disabled = false;
            alert("Update failed. Please try Ctrl+F5 instead.");
        }
    });

    // ===== Knowledge Base Events =====
    els.knowledgeBtn.addEventListener("click", () => {
        els.knowledgeModal.classList.remove("hidden");
        refreshKBArticleList();
    });

    els.closeKnowledge.addEventListener("click", () => {
        els.knowledgeModal.classList.add("hidden");
    });

    els.knowledgeModal.addEventListener("click", (e) => {
        if (e.target === els.knowledgeModal) {
            els.knowledgeModal.classList.add("hidden");
        }
    });

    // Wikipedia search
    els.kbSearchBtn.addEventListener("click", performKBSearch);
    els.kbSearchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") performKBSearch();
    });

    // Bulk download
    els.kbBulkDownload.addEventListener("click", performBulkDownload);

    // Deep Crawler
    els.kbCrawlerBtn.addEventListener("click", toggleCrawler);

    // Clear all
    els.kbClearAll.addEventListener("click", async () => {
        if (confirm("Delete all downloaded articles? This cannot be undone.")) {
            await clearAllArticles();
            refreshKBArticleList();
            updateKBBadge();
        }
    });
}

function loadSettingsUI() {
    els.modelSelect.value = state.settings.model;
    els.systemPrompt.value = state.settings.systemPrompt;
    els.temperature.value = state.settings.temperature;
    els.tempValue.textContent = state.settings.temperature;
    els.maxTokens.value = state.settings.maxTokens;
    if (els.themeSelect) els.themeSelect.value = state.settings.theme || "obsidian";
}

// ===== Knowledge Base Functions =====
async function updateKBBadge() {
    try {
        const count = await getArticleCount();
        if (count > 0) {
            els.kbBadge.textContent = count;
            els.kbBadge.classList.remove("hidden");
        } else {
            els.kbBadge.classList.add("hidden");
        }
    } catch (e) {
        console.warn("Failed to update KB badge:", e);
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function refreshKBArticleList() {
    try {
        const articles = await getAllArticles();
        els.kbCountLabel.textContent = articles.length;

        if (articles.length === 0) {
            els.kbArticleList.innerHTML = '<p class="kb-empty">No articles downloaded yet. Search or use Quick Download above.</p>';
            return;
        }

        // Sort by title
        articles.sort((a, b) => a.title.localeCompare(b.title));

        els.kbArticleList.innerHTML = articles
            .map(
                (a) => `
            <div class="kb-article-item" data-id="${a.id}">
                <span class="kb-article-title">${escapeHTML(a.title)}</span>
                <span class="kb-article-size">${formatBytes(a.sizeBytes || 0)}</span>
                <button class="kb-article-delete" data-id="${a.id}" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `
            )
            .join("");

        // Bind delete buttons
        els.kbArticleList.querySelectorAll(".kb-article-delete").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                await deleteArticle(btn.dataset.id);
                refreshKBArticleList();
                updateKBBadge();
            });
        });
    } catch (e) {
        console.error("Failed to load articles:", e);
    }
}

async function performKBSearch() {
    const query = els.kbSearchInput.value.trim();
    if (!query) return;

    els.kbSearchResults.innerHTML = '<p class="kb-empty">Searching Wikipedia...</p>';

    try {
        const results = await searchWikipedia(query);
        if (results.length === 0) {
            els.kbSearchResults.innerHTML = '<p class="kb-empty">No results found.</p>';
            return;
        }

        els.kbSearchResults.innerHTML = results
            .map(
                (r) => `
            <div class="kb-result-item">
                <div class="kb-result-info">
                    <div class="kb-result-title">${escapeHTML(r.title)}</div>
                    <div class="kb-result-snippet">${escapeHTML(r.snippet)}</div>
                </div>
                <button class="btn-download-sm" data-title="${escapeHTML(r.title)}">Download</button>
            </div>
        `
            )
            .join("");

        // Bind download buttons
        els.kbSearchResults.querySelectorAll(".btn-download-sm").forEach((btn) => {
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                btn.textContent = "Downloading...";
                try {
                    const article = await fetchArticleContent(btn.dataset.title);
                    await saveArticle(article);
                    btn.textContent = "✓ Saved";
                    btn.classList.add("downloaded");
                    refreshKBArticleList();
                    updateKBBadge();
                } catch (e) {
                    btn.textContent = "Error";
                    btn.disabled = false;
                    console.error("Download failed:", e);
                }
            });
        });
    } catch (e) {
        els.kbSearchResults.innerHTML = '<p class="kb-empty">Search failed. Check your internet connection.</p>';
        console.error("Search failed:", e);
    }
}

async function performBulkDownload() {
    els.kbBulkDownload.disabled = true;
    els.kbBulkDownload.textContent = "Downloading...";
    els.kbBulkProgress.classList.remove("hidden");

    try {
        const titles = await getPopularArticles(75);
        await fetchMultipleArticles(titles, (done, total, title) => {
            const pct = Math.round((done / total) * 100);
            els.kbProgressBar.style.width = pct + "%";
            els.kbProgressText.textContent = `${done} / ${total} — ${title}`;
        });

        els.kbBulkDownload.textContent = "✓ Download Complete";
        refreshKBArticleList();
        updateKBBadge();
    } catch (e) {
        els.kbBulkDownload.textContent = "Download Failed";
        console.error("Bulk download failed:", e);
    }

    setTimeout(() => {
        els.kbBulkDownload.disabled = false;
        els.kbBulkDownload.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download 75 Essential Articles
        `;
    }, 3000);
}

// ===== Crawler Logic =====
let isCrawlerActive = false;
async function toggleCrawler() {
    if (isCrawlerActive) {
        // Stop crawler
        stopCrawler();
        isCrawlerActive = false;
        els.kbCrawlerBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            Start Deep Archive Crawler
        `;
        els.kbCrawlerBtn.style.background = "var(--status-error)";
        els.kbCrawlerText.textContent = "Crawler stopped.";
        refreshKBArticleList();
        updateKBBadge();
    } else {
        // Start crawler
        isCrawlerActive = true;
        els.kbCrawlerBtn.textContent = "Stop Crawler";
        els.kbCrawlerBtn.style.background = "var(--text-tertiary)";
        els.kbCrawlerProgress.classList.remove("hidden");
        els.kbCrawlerText.textContent = "Connecting to Wikipedia API...";

        startDeepArchiveCrawler((total, title) => {
            els.kbCrawlerText.textContent = `Downloaded: ${total} articles (Just added: ${title})`;
            // Periodically refresh UI to show growth
            if (total % 10 === 0) {
                refreshKBArticleList();
                updateKBBadge();
            }
        });
    }
}

// ===== Initialize =====
async function init() {
    loadState();
    if (state.settings.theme) {
        document.documentElement.setAttribute("data-theme", state.settings.theme);
    }
    updateModelDisplay();
    renderChatList();
    updateKBBadge();

    // Restore current chat or show welcome
    renderMessages();

    bindEvents();
    await initEngine();
}

init();
