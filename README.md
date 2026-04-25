# 双人围棋对战（本地浏览器版）

一个无需后端、打开 `index.html` 即可双人对战的围棋小游戏。

## 功能
- 19x19 标准棋盘，黑先白后。
- 自动判断提子（按“气”规则）。
- 禁止自杀棋（除非能同时提子获得新气）。
- 禁止重复局面（实现为 Superko，防止无限循环劫争）。
- 支持 Pass，连续两次 Pass 自动终局。
- 终局按中国数子思路计分（子 + 地），白棋贴目 7.5。
- 右侧面板实时显示形势估分和落子日志。

## 使用
直接双击 `index.html`，或：

```bash
python3 -m http.server 8000
```

然后访问 `http://localhost:8000`。

## 规则参考（联网检索）
- American Go Association 规则介绍：<https://www.usgo.org/content.aspx?club_id=454497&module_id=563542&page_id=22>
- British Go Association（AGA-style 规则摘要）：<https://www.britgo.org/rules/agasummary.html>
- British Go Association（AGA 短规则，含 ko / pass / two-pass end）：<https://www.britgo.org/rules/agashort.html>
