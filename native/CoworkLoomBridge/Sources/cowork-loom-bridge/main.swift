import Foundation

import CoworkLoomRelayHost

actor StdoutEmitter {
    private let encoder = JSONEncoder()

    func emit(_ event: BridgeEvent) {
        do {
            let data = try encoder.encode(event)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            let message = "{\"type\":\"bridge_fatal\",\"message\":\"\(error.localizedDescription.replacingOccurrences(of: "\"", with: "\\\""))\"}\n"
            FileHandle.standardOutput.write(Data(message.utf8))
        }
    }
}

@main
struct CoworkLoomBridgeMain {
    static func main() async {
        let emitter = StdoutEmitter()
        let service = LoomBridgeService { event in
            Task {
                await emitter.emit(event)
            }
        }

        service.emitReady()
        await service.emitState()

        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                do {
                    let command = try JSONDecoder().decode(BridgeCommand.self, from: Data(trimmed.utf8))
                    await service.handle(command)
                } catch {
                    await emitter.emit(.log(level: .error, message: "Invalid bridge command: \(error.localizedDescription)"))
                }
            }
        } catch {
            await emitter.emit(.fatal(message: error.localizedDescription))
        }
    }
}
