import axios, { AxiosError, AxiosRequestConfig } from "axios";

import { useCallback } from "react";
import { User } from "../types/User";
import { useUserContext } from "../hooks/useUserContext";
import { jwtDecode } from "jwt-decode";
import { ENDPOINT, IS_DEVELOPMENT } from "./config";
import { serverRefreshToken } from "../services/serverAction";

// Create a reusable Axios instance with withCredentials: true for cookies
export const axiosInstance = axios.create({
  baseURL: `${ENDPOINT}/api`, // Your API base URL
  timeout: 5000,
});

// Define the structure of a retry queue item
interface RetryQueueItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value?: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reject: (error?: any) => void;
  config: AxiosRequestConfig;
}

// Function to refresh the access token using the refresh token stored in cookies

export const useAxiosInterceptor = () => {
  const { setUser, user } = useUserContext();
  // Create a list to hold the request queue
  const refreshAndRetryQueue: RetryQueueItem[] = [];
  // @TODO: Add logout functionality when both accesstoken/refreshtoken have expired.

  // Flag to prevent multiple token refresh requests
  let isRefreshing = false;

  // Add global request interceptor
  axiosInstance.interceptors.request.use(
    async (config) => {
      // Modify request config here, e.g., add headers

      if (
        config.headers?.Authorization === null &&
        config.url !== "/refresh-token" &&
        config.url !== "/logout"
      ) {
        console.log(config);
        const accessToken = await refreshAccessToken(); // Get the access token via the refresh token

        config.headers.Authorization = `Bearer ${accessToken}`;
      }

      return config;
    },
    (error) => {
      console.log("error", error);
      return Promise.reject(error);
    }
  );

  const refreshAccessToken = async () => {
    if (IS_DEVELOPMENT) {
      const { accessToken } = (await serverRefreshToken({
        id: user!.id,
      })) as User;
      return accessToken;
    }

    const { data, status } = await axiosInstance.post(
      "/refresh-token",
      { id: user?.id },
      {
        withCredentials: true, // Send refresh token (stored in cookie)
      }
    );

    if (status !== 200) {
      throw new Error("Failed to refresh token");
    }

    return data.access_token;
    return "";
  };

  axiosInstance.interceptors.response.use(
    (response) => {
      if (response.data.access_token) {
        setUser({
          ...jwtDecode(response.data.access_token),
          accessToken: response.data.access_token,
        } as User);
      }
      return response;
    },
    async (error) => {
      const originalRequest: AxiosRequestConfig = error.config;
      if (
        error.response &&
        error.response.status === 401 &&
        error.config.url !== "/refresh-token"
      ) {
        if (!isRefreshing) {
          isRefreshing = true;
          try {
            // Refresh the access token
            const newAccessToken = await refreshAccessToken();

            setUser({
              ...jwtDecode(newAccessToken),
              accessToken: newAccessToken,
            } as User);
            // Update the request headers with the new access token
            error.config.headers["Authorization"] = `Bearer ${newAccessToken}`;

            // Retry all requests in the queue with the new token
            refreshAndRetryQueue.forEach(({ config, resolve, reject }) => {
              axiosInstance
                .request(config)
                .then((response) => resolve(response))
                .catch((err) => reject(err));
            });

            // Clear the queue
            refreshAndRetryQueue.length = 0;

            // Retry the original request
            return axiosInstance(originalRequest);
          } finally {
            isRefreshing = false;
          }
        }

        // Add the original request to the queue
        return new Promise<void>((resolve, reject) => {
          refreshAndRetryQueue.push({
            config: originalRequest,
            resolve,
            reject,
          });
        });
      }

      // @TODO: Add logout functionality when both accesstoken/refreshtoken have expired.
      // setUser(null);

      // Return a Promise rejection if the status code is not 401
      return Promise.reject(error);
    }
  );
};

export const useFetchData = () => {
  const { user } = useUserContext();

  // Main request function that manages access tokens and retries failed requests
  const protectedFetcher = useCallback(
    (url: string, config: AxiosRequestConfig) => async () => {
      // Attach Authorization header with the access token
      const reqConfig = {
        ...config,
        headers: {
          ...(config.headers ?? {}),
          Authorization: user?.accessToken
            ? `Bearer ${user.accessToken}`
            : null,
        },
      };

      // Make the API request using axiosInstance
      const response = await axiosInstance(url, reqConfig);

      return response.data; // If request succeeds, return the data
    },
    [user?.accessToken]
  );

  const fetcher =
    ({ url }: { url: string }) =>
    async () => {
      try {
        const apiResponse = await axiosInstance.get(url);

        const result = apiResponse.data;
        return result;
      } catch (error) {
        console.log("Error occurred:", (error as AxiosError).message);
        return;
      }
    };

  return { protectedFetcher, fetcher };
};
