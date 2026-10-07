# FITS 主图像卡片解析与物理像素缩放后端

本项目是一个**有意限定范围**的本地 FITS 天文图像读取后端（仅 API 与 CLI，无界面），
使用 TypeScript + Node.js + SQLite（`node:sqlite` 内置模块），在 Windows 本地运行，
不依赖 Docker、WSL、付费服务或任何外部在线 API。**它不是完整的 FITS 库。**

## 支持范围（明确限定）

- 仅支持单个主 HDU：`SIMPLE=T`、`NAXIS=2`、`BITPIX=8`（无符号）或 `BITPIX=16`（有符号大端）。
- 不支持：浮点图像（BITPIX=-32/-64）、其他维数、压缩图像、扩展 HDU、多余数据块。
- 不做：天文坐标投影（WCS）、星表连接、在线图像源、目标识别、图片编辑。
- 头卡按 80 字节读取，按 36 卡（2880 字节）块对齐；`END` 卡终止头内容，
  但像素区从 `END` 所在头块的**下一块边界**开始。
- 数据区同样补齐到 2880 字节，padding 不算像素；文件不足声明大小报截断，
  多于一个主 HDU 的完整数据报 `FITS_EXTRA_DATA` 而非悄悄吞掉。

## 轴顺序与缺测语义

- `NAXIS1` 是变化最快的轴；输出矩阵为 `rows[y][x]`，`y=0` 对应轴二（NAXIS2）的第一个索引，
  **不会**为了显示自动上下翻转行。
- 物理值 = `raw * BSCALE + BZERO`（默认 BSCALE=1、BZERO=0）。
- `BLANK` 若存在必须是当前整数像素类型可表示的整数；在**缩放前**与原始值比较，
  命中则物理值为 `null`、缺测掩码为 `true`。
- 统计只包含有效物理值；全缺测时 `valid=0`，`min/max/mean` 均为 `null`（不输出 NaN）。
- 计算后检查非有限物理值，溢出报 `FITS_OVERFLOW`，不用裁剪掩盖。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 安装 typescript 与 @types/node（仅开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node --test）
npm start          # 启动 API（默认端口 0 = 自动选空闲端口）
npm run demo       # 生成夹具并演示 3x1 BITPIX=16 样例（物理值 [6,null,16]，均值 11）
```

要求 Node.js >= 22.5（使用内置 `node:sqlite`），在 Node 25 上实测通过。

## CLI

```powershell
node dist/src/cli.js help                 # 完整用法
node dist/src/cli.js make-fixtures [DIR]  # 生成合成夹具（默认 data/fixtures）
node dist/src/cli.js import <file>        # 幂等导入（按内容 SHA-256 去重）
node dist/src/cli.js list
node dist/src/cli.js cards <id>
node dist/src/cli.js pixel <id> <x> <y>   # 绝对字节偏移/原值/缩放/缺测/物理值
node dist/src/cli.js matrix <id>          # 物理值矩阵 + 缺测掩码
node dist/src/cli.js stats <id>
node dist/src/cli.js serve --port 8080    # 省略 --port 时自动选空闲端口
```

数据目录默认 `./data`，可用 `--data DIR` 或环境变量 `FITS_DATA_DIR` 覆盖；
端口可用 `--port` 或环境变量 `PORT` 指定。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/images/import` | 请求体 `{"path": "..."}`，导入本地 FITS 文件（幂等） |
| GET | `/images` | 列出已导入图像 |
| GET | `/images/:id` | 图像元信息与冻结统计 |
| GET | `/images/:id/cards` | 头卡列表（80 字符原文、关键字、解析类型、值、注释、卡片号） |
| GET | `/images/:id/pixel?x=&y=` | 像素：文件绝对偏移、原值、缩放参数、缺测判断、物理值 |
| GET | `/images/:id/matrix` | 物理值矩阵 `values[y][x]` 与掩码 `mask[y][x]` |
| GET | `/images/:id/stats` | 冻结统计（total/valid/blank/min/max/mean） |

错误统一为 `{"error": {"code", "message", "card?"}}`。
错误码：`FITS_NOT_FITS`、`FITS_UNSUPPORTED`、`FITS_BAD_HEADER`、`FITS_DUPLICATE_KEYWORD`、
`FITS_BAD_VALUE`、`FITS_TRUNCATED`、`FITS_EXTRA_DATA`、`FITS_OVERFLOW`、`LIMIT_EXCEEDED`、
`VALIDATION`、`NOT_FOUND`、`FILE_NOT_FOUND`。

## 持久化与幂等

- SQLite 库位于 `<data>/fits.db`；导入时把原文件复制为 `<data>/files/<hash>.fits` 固定副本。
- 记录解析版本（`fits-mini/1.0.0`）、冻结统计与全部头卡；重启后读取结果一致。
- 重复导入同一内容直接返回已有记录（`already=true`）；解析或溢出检查失败时不写入任何记录。
- 限制：文件 ≤ 64 MiB、像素总数 ≤ 64M，不按畸形宽高直接分配大矩阵。

## 合成夹具与测试

`npm run demo` / `make-fixtures` 生成 `data/fixtures/`：

- `demo16.fits`：3x1 BITPIX=16，raw `[-2,0,3]`，BSCALE=2、BZERO=10、BLANK=0 → 物理值 `[6,null,16]`，有效均值 11。
- `twoblock.fits`：头部跨两个 2880 块，`OBJECT = 'M31/Spitzer''s field'`（串内含斜杠与转义单引号）。
- `img8.fits`：BITPIX=8 无符号 4x2，含 BLANK=255。
- `allblank.fits`：全缺测 2x2，统计全为 null。
- `dexp.fits`：D 指数科学计数缩放。
- `bad-*.fits`：坏宽高、重复关键字、无 END、错误块长度、数据截断、缩放溢出、多余数据。

测试（`tests/`）用手写 80 字符卡片与手工大端字节独立核对偏移与解析结果，
不只依赖项目自己的写入器；并覆盖幂等导入、重启一致性、失败不登记与 HTTP 端到端。

## 已知限制

- 仅本机回环地址（127.0.0.1）监听；无鉴权，请勿暴露到网络。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）。
- 头卡值解析覆盖逻辑值、整数、有限十进制科学计数（E/D 指数）与单引号字符串；
  复数、H 型日期等 FITS 扩展语法不在本子集内。
