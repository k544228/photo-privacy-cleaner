import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '照片隱私清除器',
  description: '在瀏覽器內清除照片位置資訊、遮蓋人臉，照片不會上傳。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
