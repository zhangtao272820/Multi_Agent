import { deleteDocument } from "../utils/vectorStore";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const fileName = String(body?.fileName ?? "").trim();

  if (!fileName) {
    throw createError({
      statusCode: 400,
      statusMessage: "fileName 不能为空",
    });
  }

  const success = await deleteDocument(fileName);
  return {
    success,
    fileName,
    message: success ? "文档已从知识库删除" : "未找到该文档",
  };
});
