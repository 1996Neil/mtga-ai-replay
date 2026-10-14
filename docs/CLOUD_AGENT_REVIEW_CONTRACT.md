# 云端 ChatGPT Agent 复盘任务契约

用途：后续在用户明确批准的单场试点中，读取已脱敏证据并写一份结构化报告。本轮未执行真实数据仓库写入、收费模型调用或自动化任务。

## 先读证据，再写限定文件

1. 仅使用用户指定的私有数据仓库与默认分支。读取并记录完整 head SHA；核实仓库仍 PRIVATE。该 SHA 是本次所有文件读取的 revision，不能混用 latest 的新旧响应。
2. 读取 index.json 找唯一 match；读取对应历史目录 manifest、summary、coach、cards 及所有所需 parts。按 manifest 原字节 bytes/SHA-256 和 content_hash 核验；缺失、截断、空连接器结果、未解析引用均停止，不把未知当空局面。
3. 选定 game_number，记录实际抽查的 anchor/boundary。每个 before/after 必须真实存在。只用该边界已知的手牌和公共区，英文名来自该时点可见源；cards 字典、未来事件和赛后揭示不构成此前知识。
4. 分开说明日志事实、历史打法偏好和推断。长期上下文需会话显式提供，并记入 provenance.context_sources；不假设所有 Agent 共享记忆，也不把偏好当事件证据。整局总结可以看结果，决策建议不借未来牌为依据。
5. 产出符合 MTGA_AI_REVIEW_V1 的 JSON。sampled coverage 不能暗示全部动作正确。缺牌规则、可行动作或策略证据时说明未知，不用自报高置信度证明严重错误。
6. 通过协议/源绑定校验，构造 prepareCloudReviewWrite 计划；唯一目标为 reviews/<match-id>/game-<N>.json。记录原文件 blob SHA（不存在为 null）和预期 branch head。禁止修改 matches、latest、collection、index、Notes 或 .gitignore。

## 原子写入的工具要求

publishCloudReview 只调用注入的 client，没有默认 GitHub 写入路径；本轮通过真实临时 bare Git 的 update-ref old/new CAS 适配器验证，不能称为真实 GitHub 接入已完成。

正式适配器需实现 readTarget 和 compareAndSwapReview：先核对仓库/private/head/原 blob，再以精确原 tree 为 base 仅替换目标 review，创建单父提交（父是 expectedHeadOid），author 与 committer 都显式设置专用 GitHub noreply 身份。最后更新目标 ref，绝不 force。

GitHub 的 [Create a commit](https://docs.github.com/en/rest/git/commits#create-a-commit) 支持显式 author/committer；[Update a reference](https://docs.github.com/en/rest/git/refs#update-a-reference) 的 force=false 要求 fast-forward。精确旧 head 为唯一父的 sibling 提交，在其他写入先到后应被拒绝；强制回退及“分支先前已被回拨”的 ABA 情形仍需额外 ref 保护/适配器验证。若连接器提供真正 expected-head CAS，优先使用，并确保其提交身份满足当前校验器。不能为了连接器方便豁免任意个人邮箱。

冲突或响应丢失时停止自动重试。重新读取目标 ref/blob，核对新提交中的精确 review SHA-256；无法证明本次提交被接受就报告 unconfirmed。需要重试时重新取源和验证 head/hash，不自动 rebase、拼合 JSON 或覆盖别人报告。

GitHub 仓库级 Contents write 不等于 reviews 目录 ACL。可采用受限专用写入工具来约束操作范围，但本轮不配置真实权限。只读 Replay 使用已有私有仓库凭证，浏览器不会获得 token；云端写入凭证与模型密钥都不得写入报告。

## 授权与唤醒

真实试点需要用户指定比赛并明确批准向该私有仓库写入 review。单场批准不授权全历史批量写入、收费 API 或计划任务。GitHub 新提交不会自动唤醒普通 ChatGPT 会话；后续调度需另行设计和授权。本轮的合成样例及隔离测试不代表真实 Agent 推理质量验收。
