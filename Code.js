/**
 * Netellus Backend - Complete Logic Refactor (Phase 1 to 5)
 * Target: Google Apps Script + Firebase Firestore
 * Features: Smart Recommendations (Single/Portfolio), Cached Analytics
 */
// ================= CONFIGURATION =================
var PROJECT_ID = "netellus-solutionprovider";
var PROPS = PropertiesService.getScriptProperties();
var FIREBASE_API_KEY = PROPS.getProperty('FIREBASE_API_KEY') || "AIzaSyAkDxZ7nAjZkuq6-07yXSi07gXyB2dD1X0";
var GEMINI_API_KEY = PROPS.getProperty('GEMINI_API_KEY');
// 欄位名稱映射 (依照截圖證據：無冒號)
var KEYS = {
    INDUSTRY: "案例公司產業別",
    SYSTEM: "系統名稱",
    ACTION_TYPE: "措施類型",
    ACTION_NAME: "措施名稱",
    CARBON: "碳減量(公噸/年)",
    ENERGY: "節能潛力",
    COST: "企業投資成本(萬元)",
    SAVING: "年節省成本(萬元)",
    PAYBACK: "回收年限(年)",
    UNIT_COST: "單位減碳成本(元/噸)",
    PROB: "企業問題闡述",
    SOL: "解決方案闡述"
};
// ================= ENTRY POINT =================
function doPost(e) {
    try {
        var data = JSON.parse(e.postData.contents);
        var action = data.action;
        var result;
        // Phase 1: 儲存用戶資料
        if (action === 'saveUserProfile') {
            result = saveUserLead(data.userData);
        }
        // Phase 1.5: 智能推薦
        else if (action === 'getRecommendations') {
            result = getSmartRecommendations(data.industry, data.absoluteGoal, data.goalPath);
        }
        else if (action === 'getGeminiAnalysis') {
            // Chained AI Call
            if (data.type === 'portfolio') {
                result = callGeminiForPortfolio(data.industry, data.goal, data.items);
            } else {
                result = callGeminiForCases(data.industry, data.goal, data.items);
            }
        }
        // Phase 2, 3, 4: 統計圖表 (新版)
        else if (action === 'getDashboardStats') {
            result = getDashboardStats(data.industry, data.system, data.actionType);
        }
        // --- 緊急相容區：防止舊前端報錯 ---
        else if (action === 'getIndustryStats') {
            result = queryFirestore("Case", KEYS.INDUSTRY, data.industry);
        }
        // -------------------------------------
        else if (action === 'getAiSummary') {
            result = callGeminiCollectiveAggregation(data.textData);
        }
        else if (action === 'getScopedSummary') {
            // Compatibility with latest dataService.ts
            result = getScopedSummary(data.industry, data.system, data.actionType);
        }
        else {
            throw new Error("Unknown action: " + action);
        }
        return ContentService.createTextOutput(JSON.stringify({ success: true, data: result }))
            .setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.message }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}
// ================= PHASE 1.5: SMART RECOMMENDATION =================
function getSmartRecommendations(industry, absoluteGoal, goalPath) {
    var target = Number(absoluteGoal) || 0;
    var cleanIndustry = industry.trim();
    Logger.log("開始搜尋產業: " + cleanIndustry);
    var candidates = [];
    var searchMethod = "";
    // === 策略 1: 精確搜尋 (最優先、最省頻寬) ===
    try {
        candidates = queryFirestore("Case", "案例公司產業別", cleanIndustry);
        if (candidates.length > 0) {
            searchMethod = "Exact Match";
        }
    } catch (e) {
        Logger.log("精確搜尋失敗: " + e.message);
    }
    // === 策略 2: 模糊搜尋 (備案) ===
    if (candidates.length === 0) {
        searchMethod = "Fuzzy Match";
        // 取前 2 個字作為前綴
        var prefix = cleanIndustry.length >= 2 ? cleanIndustry.substring(0, 2) : cleanIndustry;
        // 關鍵修正：強制限制 limit = 30，防止頻寬爆炸
        candidates = queryFirestorePrefix("Case", "案例公司產業別", prefix, 30);
        // 記憶體內過濾
        candidates = candidates.filter(function (c) {
            var dbInd = (c['案例公司產業別'] || "").toString().trim();
            return dbInd.indexOf(cleanIndustry) !== -1 || cleanIndustry.indexOf(dbInd) !== -1;
        });
    }
    if (candidates.length === 0) {
        return { type: 'none', message: "搜尋完畢 (" + searchMethod + ") 但無結果。\n輸入: " + cleanIndustry + "\n請確認資料庫中是否有該產業資料。" };
    }
    // === 3. 數據計算 ===
    var scoredCases = candidates.map(function (c) {
        var caseVal = 0;
        if (goalPath === 'energy') {
            var rawEnergy = c['節能潛力'] || 0;
            caseVal = Number(rawEnergy) * 1000;
        } else {
            var rawCarbon = c['碳減量(公噸/年)'] || 0;
            caseVal = Number(rawCarbon);
        }
        c._diff = Math.abs(caseVal - target);
        c._val = caseVal;
        return c;
    });
    // 去重與排序
    var uniqueCases = [];
    var seenKeys = {};
    scoredCases.sort(function (a, b) { return a._diff - b._diff; });
    for (var i = 0; i < scoredCases.length; i++) {
        var c = scoredCases[i];
        var uniqueKey = (c['系統名稱'] || "") + "_" + (c['措施類型'] || "") + "_" + c._val;
        if (!seenKeys[uniqueKey]) {
            seenKeys[uniqueKey] = true;
            uniqueCases.push(c);
        }
        if (uniqueCases.length >= 3) break;
    }
    // === 4. 修正後動態文案生成 (User Request v2) ===
    var analysisText = "";
    if (uniqueCases.length > 0) {
        var topSystem = uniqueCases[0]['系統名稱'] || "關鍵耗能設備";
        var topAction = uniqueCases[0]['措施類型'] || "能效優化";
        
        analysisText = "根據 " + cleanIndustry + " 的大數據分析，貴產業目前在「" + topSystem + "」與「" + topAction + "」上具有最高的減碳投資效益。建議優先評估此單元進行改善評估。";
    } else {
        analysisText = "目前資料庫中暫無 " + cleanIndustry + " 的特定案例，建議先從通用的照明與空調系統盤查著手，或參考跨產業的通用最佳實踐。";
    }
    return {
        type: 'single',
        items: uniqueCases,
        targetGap: (target - (uniqueCases[0] ? uniqueCases[0]._val : 0)) > 0 ? (target - (uniqueCases[0] ? uniqueCases[0]._val : 0)) : 0,
        analysis: analysisText
    };
}
function generateSingleMatch(cases, goal, industry) {
    // Add targetGap for frontend consistency
    var result = {
        type: 'single',
        items: [],
        aiAnalysis: "",
        targetGap: goal
    };
    cases.sort(function (a, b) {
        return Math.abs(a._value - goal) - Math.abs(b._value - goal);
    });
    var bestMatch = cases[0];
    var recommendations = [bestMatch];
    for (var i = 1; i < cases.length; i++) {
        if (recommendations.length >= 3) break;
        var isSystemExist = false;
        for (var j = 0; j < recommendations.length; j++) {
            if (recommendations[j][KEYS.SYSTEM] === cases[i][KEYS.SYSTEM]) {
                isSystemExist = true;
                break;
            }
        }
        if (!isSystemExist) {
            recommendations.push(cases[i]);
        }
    }
    result.items = recommendations;
    result.aiAnalysis = callGeminiForCases(industry, goal, recommendations);
    return result;
}
function generatePortfolio(cases, goal, industry) {
    var result = {
        type: 'portfolio',
        items: [],
        aiAnalysis: "",
        targetGap: goal,
        totalValue: 0
    };
    var systemBestMap = {};
    cases.forEach(function (c) {
        var sys = c[KEYS.SYSTEM];
        if (!systemBestMap[sys] || c._val > systemBestMap[sys]._val) {
            systemBestMap[sys] = c;
        }
    });
    var sortedSystems = Object.keys(systemBestMap).map(function (k) {
        return systemBestMap[k];
    }).sort(function (a, b) { return b._value - a._value; });
    var selected = [];
    var currentSum = 0;
    for (var i = 0; i < sortedSystems.length; i++) {
        selected.push(sortedSystems[i]);
        currentSum += sortedSystems[i]._value;
        if (currentSum >= goal * 1.1) break;
    }
    result.items = selected;
    result.totalValue = currentSum;
    result.aiAnalysis = callGeminiForPortfolio(industry, goal, selected);
    return result;
}
// ================= PHASE 2, 3, 4: DASHBOARD STATS =================
function getDashboardStats(industry, system, actionType) {
    var collection = "industry_analytics_v2";
    var results = {};
    if (!system) {
        // Return ALL documents for the industry to allow frontend deduplication
        results.rawDocs = queryFirestore(collection, "industry", industry, 1000);
    }
    else if (system && !actionType) {
        var docs = queryFirestore(collection, "system", system, 100);
        var targetDoc = docs.filter(function (d) { return d.industry === industry; })[0];
        if (targetDoc && targetDoc.stats) {
            results.actionDistribution = cleanStatsKeys(targetDoc.stats, "b_");
        }
    }
    else if (system && actionType) {
        var docId = (industry + "_" + system + "_" + actionType).replace(/\//g, "-");
        var doc = getFirestoreDoc(collection, docId);
        if (doc && doc.stats) {
            results.medians = cleanStatsKeys(doc.stats, "c_");
        }
    }
    return results;
}
function cleanStatsKeys(statsObj, prefix) {
    var clean = {};
    for (var key in statsObj) {
        if (key.indexOf(prefix) === 0) {
            // Map back to standard names or keep as is.
            // Front-end should handle mapping if needed.
            clean[key] = statsObj[key];
        }
    }
    return clean;
}
// ================= FIREBASE CORE FUNCTIONS =================
function getFirestoreDoc(collection, docId) {
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/" + collection + "/" + encodeURIComponent(docId) + "?key=" + FIREBASE_API_KEY;
    try {
        var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (res.getResponseCode() === 200) {
            return parseFirestoreDoc(JSON.parse(res.getContentText()));
        }
    } catch (e) {
        throw new Error("getFirestoreDoc Error: " + e.message);
    }
    return null;
}
function queryFirestore(collection, field, value, limit) {
    // 精確查詢也加上 limit 防呆
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents:runQuery?key=" + FIREBASE_API_KEY;
    var quotedField = "`" + field + "`";
    var structuredQuery = {
        from: [{ collectionId: collection }],
        where: {
            fieldFilter: {
                field: { fieldPath: quotedField },
                op: "EQUAL",
                value: { stringValue: value }
            }
        },
        limit: limit || 50
    };
    var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ structuredQuery: structuredQuery }),
        muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return [];
    var json = JSON.parse(response.getContentText());
    var results = [];
    if (json && json.length) {
        for (var i = 0; i < json.length; i++) {
            if (json[i].document) results.push(parseFirestoreDoc(json[i].document));
        }
    }
    return results;
}
function queryFirestorePrefix(collection, field, prefix, limit) {
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents:runQuery?key=" + FIREBASE_API_KEY;
    var quotedField = "`" + field + "`";
    var structuredQuery = {
        from: [{ collectionId: collection }],
        where: {
            compositeFilter: {
                op: "AND",
                filters: [
                    {
                        fieldFilter: {
                            field: { fieldPath: quotedField },
                            op: "GREATER_THAN_OR_EQUAL",
                            value: { stringValue: prefix }
                        }
                    },
                    {
                        fieldFilter: {
                            field: { fieldPath: quotedField },
                            op: "LESS_THAN",
                            value: { stringValue: prefix + "\uf8ff" }
                        }
                    }
                ]
            }
        },
        limit: limit || 30 // 強制限制回傳筆數
    };
    var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ structuredQuery: structuredQuery }),
        muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
        Logger.log("Firestore Error: " + response.getContentText());
        return [];
    }
    var json = JSON.parse(response.getContentText());
    var results = [];
    if (json && json.length) {
        for (var i = 0; i < json.length; i++) {
            if (json[i].document) results.push(parseFirestoreDoc(json[i].document));
        }
    }
    return results;
}
function saveUserLead(userData) {
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/user_leads?key=" + FIREBASE_API_KEY;
    var fields = { "createdAt": { timestampValue: new Date().toISOString() } };
    for (var key in userData) {
        fields[key] = { stringValue: String(userData[key]) };
    }
    UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ fields: fields }),
        muteHttpExceptions: true
    });
    return { status: "success" };
}
function parseFirestoreDoc(doc) {
    var fields = doc.fields;
    var obj = {};
    if (!fields) return obj;
    for (var key in fields) {
        var val = fields[key];
        if (val.stringValue) obj[key] = val.stringValue;
        else if (val.integerValue) obj[key] = Number(val.integerValue);
        else if (val.doubleValue) obj[key] = Number(val.doubleValue);
        else if (val.booleanValue) obj[key] = val.booleanValue;
        else if (val.mapValue) obj[key] = parseFirestoreMap(val.mapValue.fields);
    }
    return obj;
}
function parseFirestoreMap(fields) {
    var obj = {};
    for (var key in fields) {
        var val = fields[key];
        if (val.doubleValue !== undefined) obj[key] = Number(val.doubleValue);
        else if (val.integerValue !== undefined) obj[key] = Number(val.integerValue);
        else if (val.stringValue) obj[key] = val.stringValue;
    }
    return obj;
}
// Compatibility helper
function getScopedSummary(industry, system, actionType) {
    var allCases = queryFirestore("Case", KEYS.INDUSTRY, industry);
    var filtered = allCases.filter(function (c) {
        var sMatch = c[KEYS.SYSTEM] === system;
        var tMatch = (c[KEYS.ACTION_TYPE] || "").indexOf(actionType) !== -1;
        return sMatch && (actionType === '其他' ? true : tMatch);
    });
    if (filtered.length === 0) return "尚無相關案例可供分析。";
    return callGeminiCollectiveAggregation(filtered);
}
function callGeminiCollectiveAggregation(items) {
    if (!GEMINI_API_KEY || items.length === 0) return "AI 顧問正在分析中...";
    var combinedText = items.slice(0, 10).map(function (c) {
        return "問題: " + (c[KEYS.PROB] || "無") + " | 方案: " + (c[KEYS.SOL] || "無");
    }).join("\n");
    var prompt = "請總結以下產業案例的核心痛點與建議：\n" + combinedText;
    return callGeminiAPI(prompt);
}
// ================= AI GENERATION (GEMINI) =================
function callGeminiForCases(industry, goal, items) {
    if (!GEMINI_API_KEY) return "API Key 未設定";
    if (!items || items.length === 0) return "無相關數據可分析";
    // 只取第一筆（最推薦/中位數分析）的資料來做深度短評
    var topItem = items[0];
    
    // 組裝精簡的 Prompt (傳統字串串接，避開 template literals 潛在問題)
    var prompt = "角色：精準犀利的產業減碳顧問。\n" +
    "產業：" + industry + "\n" +
    "推薦方案：" + topItem[KEYS.SYSTEM] + " (" + topItem[KEYS.ACTION_TYPE] + ")\n" +
    "痛點參考：" + (topItem[KEYS.PROB] || "設備老舊效率不彰") + "\n" +
    "解決方案：" + (topItem[KEYS.SOL] || "導入高效率變頻技術") + "\n\n" +
    "任務：\n" +
    "請針對上述推薦方案，寫一段 **150字以內** 的專業短評。\n" +
    "直接告訴業主為什麼這是該產業最該優先執行的項目？它的核心效益是什麼？\n\n" +
    "規定：\n" +
    "1. 不要寫任何信件開頭（如：致客戶...）。\n" +
    "2. 不要列點，請用流暢的短文呈現。\n" +
    "3. 語氣要專業、篤定且直擊核心。";
    return callGeminiAPI(prompt);
}
function callGeminiForPortfolio(industry, goal, items) {
    if (!GEMINI_API_KEY) return "AI 組合完成，但 Gemini API 未設定。";
    var prompt = "角色：產業減碳顧問。產業：" + industry + "。目標：" + goal + " (組合策略)。\n" +
        "建議採用以下多重措施的組合(Portfolio)：\n";
    items.forEach(function (c) {
        prompt += "- " + c[KEYS.SYSTEM] + " (" + c[KEYS.ACTION_TYPE] + ")\n";
    });
    prompt += "\n請說明此組合對達成大型減量目標的必要性與加乘效果。";
    return callGeminiAPI(prompt);
}
function callGeminiAPI(prompt) {
    // 【資安修正】從 Script Properties 讀取金鑰，避免金鑰外洩到 GitHub
    // 請確認已在 GAS 專案設定 -> 指令碼屬性 中設定 'GEMINI_API_KEY'
    var API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    
    if (!API_KEY) {
        console.error("錯誤：找不到 API Key。請在專案設定中設定 'GEMINI_API_KEY'。");
        return "系統錯誤：API Key 未設定。";
    }
    // 使用經過驗證的 Gemini 2.5 Flash 模型
    var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + API_KEY;
    
    try {
        var res = UrlFetchApp.fetch(url, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            muteHttpExceptions: true
        });
        
        var responseCode = res.getResponseCode();
        var responseBody = res.getContentText();
        if (responseCode !== 200) {
            console.error("API Error: " + responseCode + " - " + responseBody);
            return "錯誤：" + responseCode + " - " + responseBody;
        }
        var json = JSON.parse(responseBody);
        if (json.candidates && json.candidates[0].content) {
            return json.candidates[0].content.parts[0].text;
        } else {
             return "AI 分析完成，但無內容回傳。";
        }
    } catch (e) { 
        console.error("Runtime Error: " + e.toString());
        return "程式錯誤：" + e.toString();
    }
}
