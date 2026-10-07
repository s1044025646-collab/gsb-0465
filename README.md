# FITS 主图像解析与物理像素缩放后端

本地运行的 FITS 天文图像读取服务，仅提供 HTTP API 与 CLI（无前端）。使用 TypeScript + Node.js + SQLite（`node:sqlite` 内置模块），不依赖 Docker、WSL 或任何在线服务。

## 支持范围（明确不做的事）

- 仅支持单个主 HDU：`SIMPLE = T`、`NAXIS = 2`、`BITPIX = 8`（无符号）或 `16`（有符号大端）。
- 不支持：浮点图像（BITPIX ±32/64）、三维及以上、压缩图像、扩展 HDU（主 HDU 后有多余数据会报 `FITS_EXTRA_DATA`）。
- 不做天文坐标投影（WCS）、目标识别、星表查询、图片编辑；不连接任何在线数据源。
- 不自动修补不合法文件；本服务不是完整 FITS 库，也不假称是。

## 解析规则要点

- 头卡每张 80 个 ASCII 字节，按 36 张（2880 字节）块对齐；`END` 卡终止头内容，像素区从 END 所在块的**下一块边界**开始。
- 前 5 张卡必须依次为 `SIMPLE`、`BITPIX`、`NAXIS`、`NAXIS1`、`NAXIS2`，宽高必须为正安全整数。
- 字符串用单引号包围，其中 `''` 表示一个字面单引号；字符串内的 `/` 不是注释起点。
- `COMMENT` / `HISTORY` 可重复并保留顺序；结构/缩放关键字（SIMPLE、BITPIX、NAXIS、NAXIS1、NAXIS2、BSCALE、BZERO、BLANK）重复即拒绝。
- 数值卡支持整数与有限十进制科学计数（指数 `E`/`D` 均可）。
- 图像数据区同样补齐到 2880 字节，padding 不算像素；文件截断报 `FITS_TRUNCATED`。

## 轴顺序与缺测

- `NAXIS1` 是变化最快的轴；输出矩阵为 `rows[y][x]`，第一行对应轴二（NAXIS2）的第一个索引，**不做上下翻转**。
- 物理值 = `raw * BSCALE + BZERO`（默认 BSCALE=1、BZERO=0）。
- `BLANK` 若存在，必须是当前整数像素类型可表示的整数；在**缩放前**与原始值比较，命中则物理值为 `null`、掩码为 `true`。
- 统计（min/max/mean）只包含有效物理值；全缺测时三者均为 `null`，有效数量为 0，绝不输出 NaN。
- 计算后物理值非有限（如缩放溢出）报 `FITS_OVERFLOW`，不裁剪掩盖。

## 安装与运行（Windows）

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 生成合成夹具、导入并打印矩阵/统计/像素
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

环境变量：`PORT`（服务端口，默认 0 = 空闲端口）、`FITS_DATA_DIR`（数据目录，默认 `./data`）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/images` | 导入，body：`{"path": "文件路径"}`，幂等（按 SHA-256 去重） |
| GET | `/images` | 列出已导入图像 |
| GET | `/images/:id/cards` | 头卡列表（卡号、关键字、原文、解析类型、注释） |
| GET | `/images/:id/pixel?x=&y=` | 像素：绝对字节偏移、原值、缩放参数、缺测判断、物理值 |
| GET | `/images/:id/matrix` | 原始矩阵、物理值矩阵、缺测掩码 |
| GET | `/images/:id/stats` | 统计与缩放参数 |

错误统一返回 `{"error": {"code": "...", "message": "...", "cardIndex?": n}}`，错误码包括
`VALIDATION`、`NOT_FOUND`、`LIMIT_EXCEEDED`、`FITS_BAD_HEADER`、`FITS_UNSUPPORTED`、
`FITS_DUPLICATE_KEYWORD`、`FITS_NO_END`、`FITS_BAD_VALUE`、`FITS_TRUNCATED`、`FITS_EXTRA_DATA`、`FITS_OVERFLOW`。

## CLI

```powershell
node dist/src/cli.js import <文件路径>
node dist/src/cli.js list
node dist/src/cli.js cards <id>
node dist/src/cli.js pixel <id> <x> <y>
node dist/src/cli.js matrix <id>
node dist/src/cli.js stats <id>
node dist/src/cli.js serve [端口]
```

## 存储与一致性

- SQLite 数据库位于 `data/fits.db`；导入时把原文件固定副本存到 `data/files/<sha256>.fits`，并冻结卡片列表、统计结果与解析器版本。
- 重复导入同一文件（按 SHA-256）幂等返回已有记录；解析失败的文件不会登记为有效图像。
- 像素/矩阵查询读取固定副本并校验摘要，重启后结果一致。

## 演示夹具

`npm run demo` 在 `data/fixtures/` 生成：

- `demo16.fits`：3x1、BITPIX=16，原值 `[-2,0,3]`，BSCALE=2、BZERO=10、BLANK=0 → 物理值 `[6,null,16]`，有效均值 11。
- `demo8.fits`：BITPIX=8 无符号图像。
- `demo-all-blank.fits`：全缺测图，统计全为 null。
- `demo-long-header.fits`：头跨两个 2880 字节块（像素偏移 5760），含带斜杠与单引号的字符串卡。

## 已知限制

- 文件大小默认上限 256 MB、像素总数默认上限 64M（`src/fits/parser.ts` 中 `DEFAULT_LIMITS` 可调）。
- `node:sqlite` 在 Node 25 仍为实验特性，启动时有 ExperimentalWarning，不影响功能。
