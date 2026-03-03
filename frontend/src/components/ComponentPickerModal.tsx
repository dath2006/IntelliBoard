/**
 * Component Picker Modal
 *
 * Modal interface for searching and selecting components from the wokwi-elements library.
 * Features:
 * - Search bar with real-time filtering
 * - Category tabs for filtering
 * - Grid layout with component thumbnails
 * - Click to select and add component
 */

import React, { useState, useEffect, useMemo } from 'react';
import { ComponentRegistry } from '../services/ComponentRegistry';
import type { ComponentMetadata, ComponentCategory } from '../types/component-metadata';
import './ComponentPickerModal.css';

interface ComponentPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectComponent: (metadata: ComponentMetadata) => void;
}

export const ComponentPickerModal: React.FC<ComponentPickerModalProps> = ({
  isOpen,
  onClose,
  onSelectComponent,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ComponentCategory | 'all'>('all');
  const [registry] = useState(() => ComponentRegistry.getInstance());
  const [isLoading, setIsLoading] = useState(true);

  // Wait for registry to load
  useEffect(() => {
    const loadRegistry = async () => {
      await registry.load();
      setIsLoading(false);
    };
    loadRegistry();
  }, [registry]);

  // Filter components based on search and category
  const filteredComponents = useMemo(() => {
    if (isLoading) return [];

    let components = searchQuery
      ? registry.search(searchQuery)
      : registry.getAllComponents();

    if (selectedCategory !== 'all') {
      components = components.filter(c => c.category === selectedCategory);
    }

    return components;
  }, [searchQuery, selectedCategory, registry, isLoading]);

  // Get available categories
  const categories = useMemo(() => {
    if (isLoading) return [];
    return registry.getCategories();
  }, [registry, isLoading]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="component-picker-overlay" onClick={onClose}>
      <div className="component-picker-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Add Component</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Search Bar */}
        <div className="search-section">
          <div className="search-input-wrapper">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="search-input"
              placeholder="Search components..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery && (
              <button
                className="clear-search-btn"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Category Tabs */}
        <div className="category-tabs">
          <button
            className={`category-tab ${selectedCategory === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('all')}
          >
            All Components
          </button>
          {categories.map((category) => (
            <button
              key={category}
              className={`category-tab ${selectedCategory === category ? 'active' : ''}`}
              onClick={() => setSelectedCategory(category)}
            >
              {ComponentRegistry.getCategoryDisplayName(category)}
            </button>
          ))}
        </div>

        {/* Components Grid */}
        <div className="components-grid">
          {isLoading ? (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Loading components...</p>
            </div>
          ) : filteredComponents.length === 0 ? (
            <div className="no-results">
              <p>No components found</p>
              {searchQuery && (
                <button
                  className="clear-filters-btn"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategory('all');
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            filteredComponents.map((component) => (
              <ComponentCard
                key={component.id}
                component={component}
                onSelect={() => onSelectComponent(component)}
              />
            ))
          )}
        </div>

        {/* Footer Info */}
        <div className="modal-footer">
          <span className="component-count">
            {filteredComponents.length} component{filteredComponents.length !== 1 ? 's' : ''} available
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * Component Card - Individual component display in the grid
 */
interface ComponentCardProps {
  component: ComponentMetadata;
  onSelect: () => void;
}

const ComponentCard: React.FC<ComponentCardProps> = ({ component, onSelect }) => {
  const thumbnailRef = React.useRef<HTMLDivElement>(null);

  // Render actual web component as thumbnail
  React.useEffect(() => {
    if (!thumbnailRef.current) return;

    // Create the actual wokwi element
    const element = document.createElement(component.tagName);

    // Scale factors for different component types
    let scale = 0.5;
    if (component.tagName.includes('arduino') || component.tagName.includes('esp32')) {
      scale = 0.35; // Boards are larger, scale them down more
    } else if (component.tagName.includes('lcd') || component.tagName.includes('display')) {
      scale = 0.4; // Displays need a bit more space
    }

    (element as HTMLElement).style.transform = `scale(${scale})`;
    (element as HTMLElement).style.transformOrigin = 'center center';

    // Set default properties for better preview appearance
    if (component.tagName === 'wokwi-led') {
      (element as any).value = true; // Turn on LED
      (element as any).color = component.defaultValues?.color || 'red';
    } else if (component.tagName === 'wokwi-rgb-led') {
      (element as any).red = true;
      (element as any).green = true;
      (element as any).blue = true;
    } else if (component.tagName === 'wokwi-pushbutton') {
      (element as any).color = component.defaultValues?.color || 'red';
    } else if (component.tagName === 'wokwi-lcd1602' || component.tagName === 'wokwi-lcd2004') {
      (element as any).text = 'Hello World!';
    }

    thumbnailRef.current.innerHTML = '';
    thumbnailRef.current.appendChild(element);

    return () => {
      if (thumbnailRef.current) {
        thumbnailRef.current.innerHTML = '';
      }
    };
  }, [component.tagName, component.defaultValues]);

  return (
    <button className="component-card" onClick={onSelect}>
      <div className="card-thumbnail">
        <div ref={thumbnailRef} className="component-preview" />
      </div>
      <div className="card-content">
        <div className="card-name">{component.name}</div>
        {component.description && (
          <div className="card-description">{component.description}</div>
        )}
        <div className="card-meta">
          <span className="card-category">{component.category}</span>
          {component.pinCount > 0 && (
            <span className="card-pins">{component.pinCount} pins</span>
          )}
        </div>
      </div>
    </button>
  );
};
