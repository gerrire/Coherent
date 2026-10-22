#include "AppController.h"
#include "CallEngine.h"

#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <Velopack.hpp>
#include <livekit/livekit.h>

int main(int argc, char* argv[]) {
    Velopack::VelopackApp::Build().Run();
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName("Coherent");
    QCoreApplication::setApplicationName("Coherent");
    QQuickStyle::setStyle("Basic");
    livekit::initialize(livekit::LogLevel::Warn);
    int result = 1;
    {
        AppController controller;
        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty("controller", &controller);
        engine.addImageProvider("remote", new RemoteFrameProvider(
            static_cast<CallEngine*>(controller.callEngine())));
        engine.loadFromModule("Coherent", "Main");
        if (!engine.rootObjects().isEmpty()) result = app.exec();
    }
    livekit::shutdown();
    return result;
}
