// Synthetic moving source for desktop sharing QA. Contains no user data.
// Build with the Windows .NET Framework C# compiler; never bundle with Coherent.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Media;
using System.Windows.Forms;

sealed class MediaTestSource : Form {
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Timer timer = new Timer { Interval = 16 };
    readonly Font heading = new Font("Segoe UI", 28, FontStyle.Bold);
    readonly Font detail = new Font("Consolas", 18);
    readonly Font caption = new Font("Segoe UI", 13);
    readonly SoundPlayer tone;
    readonly MemoryStream wave;
    bool playing;
    public MediaTestSource() {
        Text = "Coherent — служебный источник видео и звука";
        ClientSize = new Size(1280, 720);
        DoubleBuffered = true;
        BackColor = Color.FromArgb(20, 17, 31);
        wave = new MemoryStream();
        var writer = new BinaryWriter(wave);
        const int rate = 48000, samples = rate;
        writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + samples * 2);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
        writer.Write((short)1); writer.Write((short)1); writer.Write(rate); writer.Write(rate * 2);
        writer.Write((short)2); writer.Write((short)16);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("data")); writer.Write(samples * 2);
        for (int i = 0; i < samples; i++) writer.Write((short)(3000 * Math.Sin(2 * Math.PI * 1000 * i / rate)));
        writer.Flush(); wave.Position = 0;
        tone = new SoundPlayer(wave); tone.Load();
        var button = new Button { Text = "Включить тестовый тон 1000 Гц", Left = 32, Top = 180, Width = 380, Height = 44 };
        button.Click += delegate {
            playing = !playing;
            if (playing) tone.PlayLooping(); else tone.Stop();
            button.Text = playing ? "Выключить тестовый тон" : "Включить тестовый тон 1000 Гц";
        };
        Controls.Add(button);
        timer.Tick += delegate { Invalidate(); }; timer.Start();
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        var g = e.Graphics;
        g.DrawString("Coherent · проверка демонстрации", heading, Brushes.White, 32, 30);
        g.DrawString("Время источника: " + clock.Elapsed.ToString(@"hh\:mm\:ss\.fff"), detail, Brushes.LightGray, 32, 95);
        g.DrawString("Синтетическое изображение · микрофон и камера не используются", caption, Brushes.LightGray, 32, 140);
        var colors = new[] { Color.FromArgb(119,57,220), Color.FromArgb(38,183,163), Color.FromArgb(237,185,71), Color.FromArgb(212,80,117) };
        int top = 260, barWidth = Math.Max(1, ClientSize.Width / colors.Length);
        for (int i = 0; i < colors.Length; i++) using (var brush = new SolidBrush(colors[i])) g.FillRectangle(brush, i * barWidth, top, barWidth, Math.Max(1, ClientSize.Height - top));
        int x = (int)(clock.Elapsed.TotalSeconds * 400) % Math.Max(1, ClientSize.Width);
        g.FillRectangle(Brushes.White, x, top, 12, Math.Max(1, ClientSize.Height - top));
        g.DrawString("ABC АБВ 0123456789", heading, Brushes.Black, 32, top + 45);
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { timer.Dispose(); tone.Stop(); tone.Dispose(); wave.Dispose(); heading.Dispose(); detail.Dispose(); caption.Dispose(); }
        base.Dispose(disposing);
    }
    [STAThread] static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new MediaTestSource()); }
}
