// ===== Wikipedia Knowledge Base =====
// Downloads, stores, and retrieves Wikipedia articles for offline RAG

const DB_NAME = "horizon-knowledge";
const DB_VERSION = 1;
const STORE_NAME = "articles";

let _db = null;

// ===== IndexedDB =====
function openDB() {
    return new Promise((resolve, reject) => {
        if (_db) return resolve(_db);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
                store.createIndex("title", "title", { unique: false });
                store.createIndex("savedAt", "savedAt", { unique: false });
            }
        };
        req.onsuccess = () => {
            _db = req.result;
            resolve(_db);
        };
        req.onerror = () => reject(req.error);
    });
}

async function saveArticle(article) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(article);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getArticle(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getAllArticles() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function deleteArticle(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getArticleCount() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function clearAllArticles() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ===== Wikipedia API =====
const WIKI_API = "https://en.wikipedia.org/api/rest_v1";
const WIKI_ACTION_API = "https://en.wikipedia.org/w/api.php";

async function searchWikipedia(query, limit = 10) {
    const url = `${WIKI_ACTION_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wikipedia search failed: ${res.status}`);
    const data = await res.json();
    return (data.query?.search || []).map((item) => ({
        id: "wiki_" + item.pageid,
        pageId: item.pageid,
        title: item.title,
        snippet: item.snippet.replace(/<[^>]+>/g, ""), // strip HTML
        wordcount: item.wordcount,
    }));
}

async function fetchArticleContent(title) {
    // Get plain text extract via Action API (more reliable)
    // Using exintro=1 to only fetch the introductory summary, shrinking payload by ~90%
    const url = `${WIKI_ACTION_API}?action=query&titles=${encodeURIComponent(title)}&prop=extracts&explaintext=1&exintro=1&exlimit=1&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch article: ${res.status}`);
    const data = await res.json();
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) {
        throw new Error(`Article not found: ${title}`);
    }
    return {
        id: "wiki_" + page.pageid,
        pageId: page.pageid,
        title: page.title,
        content: page.extract || "",
        savedAt: Date.now(),
        source: "wikipedia",
        sizeBytes: new Blob([page.extract || ""]).size,
    };
}

// Fetch multiple articles by title array
async function fetchMultipleArticles(titles, onProgress) {
    const results = [];
    for (let i = 0; i < titles.length; i++) {
        try {
            const article = await fetchArticleContent(titles[i]);
            await saveArticle(article);
            results.push({ title: titles[i], success: true });
        } catch (err) {
            results.push({ title: titles[i], success: false, error: err.message });
        }
        if (onProgress) onProgress(i + 1, titles.length, titles[i]);
    }
    return results;
}

// ===== Automated Knowledge Crawler =====
let _isCrawlerRunning = false;

function stopCrawler() {
    _isCrawlerRunning = false;
}

async function startDeepArchiveCrawler(onProgress) {
    if (_isCrawlerRunning) return;
    _isCrawlerRunning = true;
    let totalDownloaded = 0;

    while (_isCrawlerRunning) {
        try {
            // Fetch 10 random article titles
            const randomUrl = `${WIKI_ACTION_API}?action=query&format=json&list=random&rnnamespace=0&rnlimit=10&origin=*`;
            const res = await fetch(randomUrl);
            if (!res.ok) throw new Error("Random API failed");
            const data = await res.json();
            const randomTitles = (data.query?.random || []).map(item => item.title);

            if (randomTitles.length === 0) break;

            // Fetch and save the contents of those 10 random articles
            for (let i = 0; i < randomTitles.length; i++) {
                if (!_isCrawlerRunning) break;
                try {
                    const article = await fetchArticleContent(randomTitles[i]);
                    // Only save if it has meaningful content
                    if (article.content && article.content.length > 500) {
                        await saveArticle(article);
                        totalDownloaded++;
                        if (onProgress) onProgress(totalDownloaded, randomTitles[i]);
                    }
                } catch (e) {
                    // silently skip failed articles
                }
            }
        } catch (err) {
            console.error("Crawler error:", err);
            // Brief pause on error to avoid spamming
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Get popular/featured articles for bulk download
async function getPopularArticles(limit = 50) {
    // Use "vital articles" — Wikipedia's curated list of most important topics
    const vitalTopics = [
        // Science
        "Physics", "Chemistry", "Biology", "Mathematics", "Computer science",
        "Astronomy", "Geology", "Evolution", "DNA", "Atom",
        "Quantum mechanics", "Theory of relativity", "Electromagnetism",
        "Thermodynamics", "Cell (biology)", "Genetics", "Ecology", "Botany",
        // Technology
        "Artificial intelligence", "Internet", "Computer", "Algorithm",
        "Machine learning", "Programming language", "World Wide Web",
        "Smartphone", "Electric vehicle", "Renewable energy", "Robotics",
        // History
        "World War I", "World War II", "Ancient Rome", "Ancient Greece",
        "Industrial Revolution", "French Revolution", "Cold War",
        "Renaissance", "Middle Ages", "Age of Enlightenment", "American Revolution",
        // Geography
        "Earth", "Ocean", "Continent", "Climate", "Mountain",
        "Amazon rainforest", "Sahara", "Pacific Ocean", "Antarctica", "Asia",
        // People
        "Albert Einstein", "Isaac Newton", "Charles Darwin",
        "Leonardo da Vinci", "Nikola Tesla", "Marie Curie",
        "William Shakespeare", "Aristotle", "Galileo Galilei", "Plato",
        // Arts & Culture
        "Music", "Literature", "Philosophy", "Art", "Film", "Architecture",
        // Health & Body
        "Human body", "Brain", "Heart", "Immune system", "Virus",
        "Vaccine", "Nutrition", "Mental health", "Medicine",
        // Space
        "Solar System", "Sun", "Moon", "Mars", "Black hole",
        "Galaxy", "Universe", "Big Bang", "Milky Way", "Exoplanet",
        // Society
        "Democracy", "Economics", "United Nations", "Human rights",
        "Education", "Language", "Law", "Government", "Psychology"
    ];
    // Return all of them without clipping to 50
    return vitalTopics;
}

// ===== Local Search (RAG Retrieval) =====

// Tokenize and normalize text for search
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
}

// Build a simple inverted index from tokens
function buildTermFrequency(tokens) {
    const freq = {};
    for (const token of tokens) {
        freq[token] = (freq[token] || 0) + 1;
    }
    return freq;
}

// Split article into chunks for context injection
function chunkText(text, chunkSize = 800, overlap = 100) {
    const words = text.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
        const chunk = words.slice(i, i + chunkSize).join(" ");
        if (chunk.trim().length > 50) {
            chunks.push(chunk);
        }
    }
    return chunks;
}

// Score a chunk against a query using BM25-like scoring
function scoreChunk(queryTokens, chunkTokens) {
    const chunkFreq = buildTermFrequency(chunkTokens);
    let score = 0;
    const k = 1.5;
    const b = 0.75;
    const avgLen = 400;
    const docLen = chunkTokens.length;

    for (const qt of queryTokens) {
        const tf = chunkFreq[qt] || 0;
        if (tf > 0) {
            // BM25-inspired scoring
            const idf = Math.log(1 + 1 / (tf + 0.5));
            const tfNorm = (tf * (k + 1)) / (tf + k * (1 - b + b * (docLen / avgLen)));
            score += idf * tfNorm;
        }
    }
    return score;
}

// Search downloaded articles and return relevant context chunks
async function searchKnowledgeBase(query, maxChunks = 3, maxContextLength = 2000) {
    const articles = await getAllArticles();
    if (articles.length === 0) return null;

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return null;

    // Score all chunks from all articles
    const scoredChunks = [];
    for (const article of articles) {
        const chunks = chunkText(article.content);
        for (const chunk of chunks) {
            const chunkTokens = tokenize(chunk);
            const score = scoreChunk(queryTokens, chunkTokens);
            if (score > 0) {
                scoredChunks.push({
                    score,
                    chunk,
                    title: article.title,
                });
            }
        }
    }

    // Sort by score descending
    scoredChunks.sort((a, b) => b.score - a.score);

    // Take top chunks within context length budget
    const selected = [];
    let totalLen = 0;
    for (const item of scoredChunks.slice(0, maxChunks * 2)) {
        if (totalLen + item.chunk.length > maxContextLength) break;
        selected.push(item);
        totalLen += item.chunk.length;
        if (selected.length >= maxChunks) break;
    }

    if (selected.length === 0) return null;

    // Format as context string
    const contextParts = selected.map(
        (s) => `[Source: Wikipedia — ${s.title}]\n${s.chunk}`
    );
    return contextParts.join("\n\n---\n\n");
}

// ===== Live Internet Search =====
async function performLiveInternetSearch(query) {
    try {
        // Fetch top 3 results from live Wikipedia API
        const results = await searchWikipedia(query, 3);
        if (results.length === 0) return null;

        let contextParts = [];
        for (const item of results) {
            try {
                // Fetch the actual introductory content of each result
                const article = await fetchArticleContent(item.title);
                contextParts.push(`[Source: Live Internet / Wikipedia — ${article.title}]\n${article.content}`);
            } catch (err) {
                console.warn("Failed to fetch live article content:", err);
                // Fallback to the snippet if full content fails
                contextParts.push(`[Source: Live Internet / Wikipedia — ${item.title}]\n${item.snippet}`);
            }
        }
        return contextParts.join("\n\n---\n\n");
    } catch (e) {
        console.error("Live internet search failed:", e);
        return null;
    }
}

// ===== Exports =====
export {
    searchWikipedia,
    fetchArticleContent,
    fetchMultipleArticles,
    getPopularArticles,
    saveArticle,
    getArticle,
    getAllArticles,
    deleteArticle,
    getArticleCount,
    clearAllArticles,
    searchKnowledgeBase,
    performLiveInternetSearch,
    startDeepArchiveCrawler,
    stopCrawler,
};
