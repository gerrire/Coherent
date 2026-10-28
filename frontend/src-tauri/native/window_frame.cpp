#define NOMINMAX
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <algorithm>
#include <new>

namespace {
constexpr UINT_PTR subclass_id = 0x434F4846;
constexpr wchar_t overlay_class[] = L"Coherent.NativeCaption";
struct Frame {
    HWND parent, drag = nullptr, maximize = nullptr;
    bool pressed = false;
    bool hovering = false, visible = true;
    void (*event)(void*, int);
    void* context;
};

void position(Frame* frame) {
    if (!frame->visible) {
        ShowWindow(frame->drag, SW_HIDE);
        ShowWindow(frame->maximize, SW_HIDE);
        return;
    }
    RECT client{};
    GetClientRect(frame->parent, &client);
    const UINT dpi = GetDpiForWindow(frame->parent);
    const int button = MulDiv(46, dpi, 96);
    const int height = MulDiv(36, dpi, 96);
    // Leave the resize border available, including at fractional DPI.
    const int edge = IsZoomed(frame->parent) ? 0 : MulDiv(5, dpi, 96);
    SetWindowPos(frame->drag, HWND_TOP, edge, edge,
        std::max(0L, client.right - 4 * button - edge), height - edge,
        SWP_NOACTIVATE | SWP_SHOWWINDOW);
    SetWindowPos(frame->maximize, HWND_TOP, client.right - 2 * button, edge,
        button, height - edge, SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

LRESULT CALLBACK overlay_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* frame = reinterpret_cast<Frame*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        frame = static_cast<Frame*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(frame));
    }
    if (!frame) return DefWindowProcW(window, message, wparam, lparam);
    const bool maximize = window == frame->maximize;
    switch (message) {
    case WM_NCHITTEST: return maximize ? HTMAXBUTTON : HTCAPTION;
    case WM_NCMOUSEMOVE: {
        if (maximize) {
            TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE | TME_NONCLIENT, window, 0};
            TrackMouseEvent(&track);
            if (!frame->hovering) { frame->hovering = true; frame->event(frame->context, 1); }
        }
        return 0;
    }
    case WM_NCMOUSELEAVE:
        frame->pressed = false;
        if (maximize) { frame->hovering = false; frame->event(frame->context, 0); }
        return 0;
    case WM_NCLBUTTONDOWN:
        if (maximize) { frame->pressed = true; return 0; }
        ReleaseCapture();
        // Windows owns the move loop: Aero Snap, restore-on-drag and all DPI handling.
        return SendMessageW(frame->parent, WM_NCLBUTTONDOWN, HTCAPTION, lparam);
    case WM_NCLBUTTONDBLCLK:
        if (!maximize) SendMessageW(frame->parent, WM_SYSCOMMAND,
            IsZoomed(frame->parent) ? SC_RESTORE : SC_MAXIMIZE, 0);
        return 0;
    case WM_NCLBUTTONUP:
        if (maximize && frame->pressed) {
            frame->pressed = false;
            SendMessageW(frame->parent, WM_SYSCOMMAND,
                IsZoomed(frame->parent) ? SC_RESTORE : SC_MAXIMIZE, 0);
        }
        return 0;
    case WM_NCRBUTTONUP:
        return SendMessageW(frame->parent, WM_NCRBUTTONUP, HTCAPTION, lparam);
    case WM_ERASEBKGND: return 1;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

LRESULT CALLBACK parent_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam,
    UINT_PTR, DWORD_PTR data) {
    auto* frame = reinterpret_cast<Frame*>(data);
    const auto result = DefSubclassProc(window, message, wparam, lparam);
    if (message == WM_SIZE || message == WM_DPICHANGED) position(frame);
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(window, parent_proc, subclass_id);
        frame->event(frame->context, -1);
        delete frame;
    }
    return result;
}
}

extern "C" bool coherent_install_window_frame(HWND parent, void (*event)(void*, int), void* context) {
    WNDCLASSEXW cls{sizeof(cls)};
    cls.style = CS_DBLCLKS;
    cls.lpfnWndProc = overlay_proc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.lpszClassName = overlay_class;
    // No background: the native hit surfaces leave the React titlebar visible.
    RegisterClassExW(&cls);
    auto* frame = new (std::nothrow) Frame{parent, nullptr, nullptr, false, false, true, event, context};
    if (!frame) return false;
    const auto create = [&]() { return CreateWindowExW(0, overlay_class, L"",
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS, 0, 0, 0, 0,
        parent, nullptr, cls.hInstance, frame); };
    frame->drag = create();
    frame->maximize = create();
    if (!frame->drag || !frame->maximize ||
        !SetWindowSubclass(parent, parent_proc, subclass_id, reinterpret_cast<DWORD_PTR>(frame))) {
        if (frame->drag) DestroyWindow(frame->drag);
        if (frame->maximize) DestroyWindow(frame->maximize);
        delete frame;
        return false;
    }
    DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_ROUND;
    DwmSetWindowAttribute(parent, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
    position(frame);
    return true;
}

extern "C" void coherent_window_frame_visible(HWND parent, bool visible) {
    DWORD_PTR data = 0;
    if (GetWindowSubclass(parent, parent_proc, subclass_id, &data)) {
        auto* frame = reinterpret_cast<Frame*>(data);
        frame->visible = visible;
        frame->pressed = frame->hovering = false;
        frame->event(frame->context, 0);
        position(frame);
    }
}
