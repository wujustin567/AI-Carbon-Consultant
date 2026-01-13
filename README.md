#  AI 產業減碳顧問系統 (Netellus AI Carbon Consultant)

這是一個基於 **Google Gemini 2.5 Flash** 模型開發的智慧型減碳策略分析系統。
透過分析各產業的能源痛點，系統能自動生成精準、具成本效益的 1% 減碳路徑建議。

## 🚀 立即體驗 (Live Demo)
> **[👉 點此開啟 AI 減碳顧問網頁](https://script.google.com/macros/s/AKfycbzBhI35AKXqQQOGbwurD7brdmKzFLWB_xAKYXKTG-mQExwkYv_paYKN3LrDeWE9xAHE/exec)**

---

## ✨ 功能特色
- **精準痛點分析**：針對電力設備製造、電子零組件等產業提供深度節能見解。
- **Gemini 2.5 核心**：採用最新一代 Gemini 2.5 Flash 模型，生成速度快且邏輯嚴謹。
- **前後端分離架構**：
  - **前端**：使用 React + Tailwind CSS 打造的響應式儀表板。
  - **後端**：Google Apps Script (GAS) 處理 API 調度與資料邏輯。
- **資安合規**：全系統金鑰採環境變數管理，不洩露私鑰於原始碼中。

## 🛠️ 技術棧 (Tech Stack)
- **Language**: TypeScript (Frontend), Google Apps Script (Backend)
- **AI Model**: `gemini-2.5-flash`
- **Styling**: Tailwind CSS

## 📝 開發歷程
1. **API 調校**：解決了舊版模型（1.5）停用導致的 404 錯誤，成功遷移至 2.5 版本。
2. **資安淨化**：移除硬編碼金鑰，改採 `PropertiesService` 安全讀取。
3. **部署優化**：將複雜的前端資源打包為單一 `standalone.html` 以利快速部署。
