import Database from "better-sqlite3";

const db = new Database("./storage/data.db");

// 最新のプロジェクトを取得
const projects = db.prepare(`
  SELECT id, title, status, errorMessage, slideUrl, createdAt 
  FROM projects 
  ORDER BY id DESC 
  LIMIT 5
`).all();

console.log("最新のプロジェクト:");
projects.forEach(p => {
  console.log(`\nID: ${p.id}`);
  console.log(`タイトル: ${p.title}`);
  console.log(`ステータス: ${p.status}`);
  console.log(`スライドURL: ${p.slideUrl || "未生成"}`);
  if (p.errorMessage) {
    console.log(`エラー: ${p.errorMessage}`);
  }
});

db.close();
