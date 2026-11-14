# arkops-portal 专用分支开发约定

本分支专门用于 `arkops-portal` 前端开发。

- 应用代码、配置、资源、脚本和依赖放在 `arkops-portal/`；根目录仅放仓库说明和开发约定。
- 产品文档放在 `arkops-portal/docs/product/`，前端接口契约和外部服务接入文档放在 `arkops-portal/docs/integration/`。
- 文档只写“为什么和决策”，不写“现状清单”：模块现状以代码为准，避免文档与代码脱节。新增文档前先确认它回答了代码回答不了的问题，否则不建。
- 现有的长期文档只有四类：`product-design.md`（产品权威）、`docs/product/iteration-log.md`（变更记录）、`docs/product/roadmap.md`（未来规划）、`docs/product/competitive-analysis.md`（竞品情报）；`docs/product/notes/` 只放原始想法，不做维护。
- 开发前阅读 `arkops-portal/README.md` 和 `arkops-portal/product-design.md`；导航或页面范围变化时同步更新产品设计、README 和路由。
- 复用现有组件、领域类型和 Mock API；用户可见文案遵循现有 i18n 约定。
- 修改前端代码、依赖或构建配置后，在 `arkops-portal/` 运行 `npm run build`。
- 不提交 `.env.local`、凭据、`node_modules` 或构建产物。
- 不在此分支添加其他应用或后端服务；跨项目需求以接入契约或文档记录。
