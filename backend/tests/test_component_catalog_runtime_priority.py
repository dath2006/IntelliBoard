from app.agent.catalog import get_component_schema
from app.agent.runtime_pin_catalog import record_pin_observation


def test_runtime_pin_names_win_over_metadata(monkeypatch):
    monkeypatch.setattr(
        "app.agent.catalog.load_component_catalog",
        lambda: [
            {
                "id": "demo-led",
                "tagName": "wokwi-demo-led",
                "name": "Demo LED",
                "category": "output",
                "description": "",
                "pinCount": 2,
                "pinNames": ["A", "C", "WRONG"],
                "defaultValues": {},
                "properties": [],
            }
        ],
    )

    record_pin_observation(
        metadata_id="demo-led",
        tag_name="wokwi-demo-led",
        pin_names=["A", "C"],
        signature="shape=default",
    )

    schema = get_component_schema("demo-led")

    assert schema["pinNames"] == ["A", "C"]
    assert schema["runtimePinNames"] == ["A", "C"]
    assert schema["metadataPinNames"] == ["A", "C", "WRONG"]
    assert schema["pinNamesSource"] == "runtime+catalog"
