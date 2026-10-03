import React from 'react';
import { AlertProvider } from './context/AlertContext';
import { StatusProvider } from './context/StatusContext';
const RootProvider = ({ children }) => {
  return (
    <AlertProvider>
      <StatusProvider>{children}</StatusProvider>
    </AlertProvider>
  );
};

export default RootProvider;
