const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// 정적 파일(public) 제공
app.use(express.static(path.join(__dirname, "public")));

// MEXC 가격 프록시 API (CORS 해결)
app.get("/api/price", async (req, res) => {
  const symbol = req.query.symbol || "BTC_USDT";

  try {
    const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.success) {
      return res.status(500).json({ error: "MEXC API error", raw: data });
    }

    res.json({
      symbol,
      price: data.data.lastPrice,
      fairPrice: data.data.fairPrice,
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});