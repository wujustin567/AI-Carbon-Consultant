/**
 * Netellus Backend (Firestore REST Version - ES5 Safe)
 * 
 * Project ID: netellus-solutionprovider
 * Collections: 'Case' (Read), 'user_leads' (Write)
 * Authentication: Web API Key (REST)
 */

var PROJECT_ID = "netellus-solutionprovider";
var PROPS = PropertiesService.getScriptProperties();
var FIREBASE_API_KEY = PROPS.getProperty('FIREBASE_API_KEY');
var GEMINI_API_KEY = PROPS.getProperty('GEMINI_API_KEY');

// === TEST FUNCTION - Run this manually in GAS editor ===
function testFirestoreConnection() {
    Logger.log("=== Testing Firestore Connection ===");
    Logger.log("Project ID: " + PROJECT_ID);
    Logger.log("API Key (first 20 chars): " + FIREBASE_API_KEY.substring(0, 20) + "...");

    try {
        var results = getIndustryStats("教育業");
        Logger.log("SUCCESS! Fetched " + results.length + " documents");

        if (results.length > 0) {
            Logger.log("First document:");
            Logger.log(JSON.stringify(results[0], null, 2));
        } else {
            Logger.log("WARNING: No documents found for 教育業");
        }
    } catch (e) {
        Logger.log("ERROR: " + e.message);
        Logger.log("Stack: " + e.stack);
    }
}

// --- Entry Points ---
function doGet(e) {
    if (e && e.parameter && e.parameter.action === 'sync') {
        try {
            syncFirebaseLeadsToSheet();
            return ContentService.createTextOutput(JSON.stringify({ success: true, message: "Sync triggered" })).setMimeType(ContentService.MimeType.JSON);
        } catch (err) {
            return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
        }
    }

    // Default: Serve index.html
    return HtmlService.createHtmlOutputFromFile('index')
        .setTitle('Netellus - 企業減碳決策支援系統')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
    try {
        var data = JSON.parse(e.postData.contents);
        var action = data.action;

        var result;
        if (action === 'getIndustryStats') {
            result = getIndustryStats(data.industry);
        } else if (action === 'getRecommendations') {
            result = getRecommendations(data.industry, data.goal, data.goalPath);
        } else if (action === 'saveUserProfile') {
            result = saveUserLead(data.userData);
        } else {
            throw new Error("Unknown action: " + action);
        }

        return ContentService.createTextOutput(JSON.stringify({ success: true, data: result })).setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.message, stack: error.stack })).setMimeType(ContentService.MimeType.JSON);
    }
}

// --- Firestore Logic (REST) ---

function getIndustryStats(industry) {
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents:runQuery?key=" + FIREBASE_API_KEY;

    var structuredQuery = {
        from: [{ collectionId: "Case" }]
    };

    if (industry) {
        structuredQuery.where = {
            fieldFilter: {
                field: { fieldPath: "`案例公司產業別`" },
                op: "EQUAL",
                value: { stringValue: industry }
            }
        };
    } else {
        structuredQuery.limit = 500;
    }

    var payload = { structuredQuery: structuredQuery };

    Logger.log("Querying Firestore...");
    Logger.log("URL: " + url.substring(0, 100) + "...");

    var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    });

    Logger.log("Response Code: " + response.getResponseCode());

    if (response.getResponseCode() !== 200) {
        var errorText = response.getContentText();
        Logger.log("Error Response: " + errorText);
        throw new Error("Firestore Read Error: " + errorText);
    }

    var json = JSON.parse(response.getContentText());
    if (!json || !json.length) {
        Logger.log("No documents returned");
        return [];
    }

    var results = [];
    for (var i = 0; i < json.length; i++) {
        if (json[i].document) {
            results.push(parseFirestoreDoc(json[i].document));
        }
    }

    Logger.log("Fetched " + results.length + " documents");

    return results;
}

function saveUserLead(userData) {
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/user_leads?key=" + FIREBASE_API_KEY;

    var fields = {};
    fields["createdAt"] = { timestampValue: new Date().toISOString() };

    for (var key in userData) {
        if (userData.hasOwnProperty(key)) {
            fields[key] = { stringValue: String(userData[key]) };
        }
    }

    var payload = { fields: fields };

    var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) throw new Error("Firestore Write Error: " + response.getContentText());

    var json = JSON.parse(response.getContentText());
    return { status: "created", id: json.name };
}

function parseFirestoreDoc(doc) {
    var fields = doc.fields;
    var obj = {};

    for (var key in fields) {
        var val = fields[key];
        if (val.stringValue) obj[key] = val.stringValue;
        else if (val.integerValue) obj[key] = Number(val.integerValue);
        else if (val.doubleValue) obj[key] = Number(val.doubleValue);
        else if (val.booleanValue) obj[key] = val.booleanValue;
    }
    return obj;
}

// --- Business Logic ---

function getRecommendations(industry, goalValue, goalPath) {
    var allCases = getIndustryStats(industry);
    var targetField = goalPath === 'energy' ? '節能潛力' : '碳減量(公噸/年)';

    if (allCases.length === 0) return { type: 'none', items: [], aiAnalysis: "No data found." };

    var validCases = [];
    for (var i = 0; i < allCases.length; i++) {
        var c = allCases[i];
        c[targetField] = Number(c[targetField] || 0);

        if (c[targetField] > 0) {
            c._val = c[targetField];
            validCases.push(c);
        }
    }

    validCases.sort(function (a, b) {
        return Math.abs(a._val - goalValue) - Math.abs(b._val - goalValue);
    });

    var bestCase = validCases[0] || allCases[0];
    var resultType = 'single';
    var selectedItems = [];

    if (goalValue > (bestCase._val * 5)) {
        resultType = 'combo';

        var systemsKey = {};
        for (var j = 0; j < validCases.length; j++) { systemsKey[validCases[j]["系統名稱"]] = true; }
        var systems = Object.keys(systemsKey);

        var currentSum = 0;
        var sortedByVal = validCases.slice().sort(function (a, b) { return b._val - a._val; });

        for (var k = 0; k < systems.length; k++) {
            var sys = systems[k];
            if (currentSum >= goalValue) break;

            var pick = null;
            for (var m = 0; m < sortedByVal.length; m++) {
                if (sortedByVal[m]["系統名稱"] === sys) {
                    pick = sortedByVal[m];
                    break;
                }
            }
            if (pick) {
                selectedItems.push(pick);
                currentSum += pick._val;
            }
        }
        if (selectedItems.length === 0) selectedItems.push(bestCase);
    } else {
        selectedItems.push(bestCase);
        var alts = validCases.filter(function (c) { return c["措施類型"] !== bestCase["措施類型"]; }).slice(0, 2);
        for (var n = 0; n < alts.length; n++) selectedItems.push(alts[n]);
    }

    var enhanced = enhanceRecommendationsWithAI(selectedItems, industry);
    var aiAnalysis = callGemini(industry, goalValue, goalPath, enhanced);

    return { type: resultType, items: enhanced, targetGap: goalValue, aiAnalysis: aiAnalysis };
}

// --- AI Logic ---

function enhanceRecommendationsWithAI(items, industry) {
    if (!GEMINI_API_KEY || items.length === 0) return items;

    var casesText = items.map(function (c, i) {
        return "Case " + i + ": Prob:" + (c["企業問題闡述"] || "") + ", Sol:" + (c["解決方案闡述"] || "");
    }).join("\n");

    var prompt = "Role: Consultant for " + industry + ". Task: Summarize Pain Points/Solutions. Input:\n" + casesText + "\nOutput JSON Array [{ \"ai_pain_point\": \"...\", \"ai_solution\": \"...\" }]. JSON ONLY.";

    try {
        var resContent = callGeminiAPI(prompt);
        var cleanJson = resContent.replace(/```json|```/g, '').trim();
        var json = JSON.parse(cleanJson);

        return items.map(function (item, i) {
            if (json[i]) {
                item.ai_pain_point = json[i].ai_pain_point;
                item.ai_solution = json[i].ai_solution;
            }
            return item;
        });
    } catch (e) { return items; }
}

function callGemini(industry, goal, path, items) {
    if (!GEMINI_API_KEY) return "Gemini Key Not Set";

    var itemsText = items.map(function (c) { return "- " + c["系統名稱"] + ": " + c["措施名稱"]; }).join("\n");
    var prompt = "Industry:" + industry + ", Goal:" + goal + ". Logic Reference:\n" + itemsText + "\nWrite strategy report (Markdown, Traditional Chinese).";
    return callGeminiAPI(prompt);
}

function callGeminiAPI(prompt) {
    var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=" + GEMINI_API_KEY;
    var payload = { contents: [{ parts: [{ text: prompt }] }] };

    try {
        var res = UrlFetchApp.fetch(url, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });
        var json = JSON.parse(res.getContentText());
        if (json.candidates && json.candidates[0]) {
            return json.candidates[0].content.parts[0].text;
        }
        return "AI Error or Default Answer";
    } catch (e) { return "AI Network Error"; }
}

// --- Firebase to Sheet Sync ---

function syncFirebaseLeadsToSheet() {
    var SPREADSHEET_ID = "1VNlpCCe1Hl2kmVrPDA3JAw4-sJHOWrsIsbH70xgSejU";
    var FIREBASE_API_KEY = PropertiesService.getScriptProperties().getProperty('FIREBASE_API_KEY');
    var baseUrl = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/user_leads?key=" + FIREBASE_API_KEY;

    Logger.log("Fetching documents from Firestore...");
    var allDocs = [];
    var pageToken = "";

    do {
        var url = baseUrl + (pageToken ? "&pageToken=" + pageToken : "");
        var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        if (response.getResponseCode() !== 200) {
            throw new Error("Firestore Read Error: " + response.getContentText());
        }
        var json = JSON.parse(response.getContentText());
        if (json.documents) {
            allDocs = allDocs.concat(json.documents);
        }
        pageToken = json.nextPageToken;
    } while (pageToken);

    if (allDocs.length === 0) {
        Logger.log("No data found in Firestore.");
        return;
    }

    // Merge data by docId
    var mergedLeads = {};
    for (var i = 0; i < allDocs.length; i++) {
        var entry = parseFirestoreDoc(allDocs[i]);
        var docId = entry.docId;
        if (!docId) continue;

        if (!mergedLeads[docId]) {
            mergedLeads[docId] = {};
        }

        // Populate fields, newer fields overwrite older ones except createdAt
        for (var field in entry) {
            if (field === "createdAt" && mergedLeads[docId].createdAt) continue;
            mergedLeads[docId][field] = entry[field];
        }
    }

    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheets()[0];
    var sheetData = sheet.getDataRange().getValues();

    // Map docId to row index (1-indexed)
    var docIdMap = {};
    for (var i = 1; i < sheetData.length; i++) {
        var dId = sheetData[i][2]; // Column C: docId
        if (dId) docIdMap[dId] = i + 1;
    }

    function parseTimestamp(ts) {
        if (!ts) return null;
        if (typeof ts === 'string') return new Date(ts);
        if (ts.seconds) return new Date(ts.seconds * 1000);
        return ts;
    }

    function parseNumber(val) {
        if (typeof val === 'number') return val;
        if (typeof val === 'string') {
            var n = parseFloat(val.replace(/,/g, ''));
            return isNaN(n) ? val : n;
        }
        return val;
    }

    for (var docId in mergedLeads) {
        var lead = mergedLeads[docId];
        var rowData = [
            parseTimestamp(lead.createdAt),       // A: 建立時間
            parseTimestamp(lead.lastUpdated),     // B: 最後更新
            lead.docId,                          // C: docId
            lead.industry,                       // D: 產業
            lead.phone,                          // E: 電話
            lead.taxId,                          // F: 統編
            parseNumber(lead.baseline_total),    // G: 基準總量
            lead.baseline_unit,                  // H: 單位
            parseNumber(lead.reduction_target),  // I: 減量目標
            lead.reduction_type,                 // J: 目標類型
            lead.email                           // K: Email
        ];

        if (docIdMap[docId]) {
            sheet.getRange(docIdMap[docId], 1, 1, rowData.length).setValues([rowData]);
            Logger.log("Updated docId: " + docId);
        } else {
            sheet.appendRow(rowData);
            Logger.log("Appended docId: " + docId);
        }
    }

    Logger.log("Sync completed.");
}
